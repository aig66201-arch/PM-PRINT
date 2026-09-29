const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ACTIVE_ORDER_STATUSES = ['Pending','Accepted','Printing','In Transit','Ready to Pickup','Delivered'];
const ALL_ORDER_STATUSES = ['Pending','Accepted','Declined','Printing','Completed','In Transit','Ready to Pickup','Delivered'];

function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
}
function err(message,status=400){ return json({success:false,error:message},status); }
function now(){return new Date().toISOString();}
function id(prefix='ID'){return `${prefix}-${crypto.randomUUID()}`;}
function clean(v=''){return String(v??'').trim();}
function num(v,d=0){const n=Number(v); return Number.isFinite(n)?n:d;}
function decimalToCents(v){
  const text=clean(v);
  if(!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Invalid peso amount.');
  const [whole,frac='']=text.split('.');
  return BigInt(whole)*100n+BigInt((frac+'00').slice(0,2));
}
function centsToNumber(c){return Number(c)/100;}
function roundWholePeso(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n<=0)return 0;
  return roundPesoHalfUpDecimalSafe(n);
}
function roundPesoHalfUpDecimalSafe(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n<=0)return 0;
  const text=n.toFixed(6);
  const [wholeText,fracText='']=text.split('.');
  const micros=BigInt(wholeText)*1000000n+BigInt((fracText+'000000').slice(0,6));
  const whole=micros/1000000n,decimal=micros%1000000n;
  return Number(decimal<500000n?whole:whole+1n);
}
function wholePesoAdjustment(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n<=0)return {subtotal:0,discount:0,finalTotal:0};
  // Work in micro-pesos so the .50 boundary is not decided by a binary float.
  const micros=BigInt(Math.round(n*1000000));
  const wholeMicros=(micros/1000000n)*1000000n;
  const decimalMicros=micros-wholeMicros;
  if(decimalMicros<500000n){
    return {subtotal:Number(micros)/1000000,discount:Number(decimalMicros)/1000000,finalTotal:Number(wholeMicros)/1000000};
  }
  return {subtotal:Number(micros)/1000000,discount:0,finalTotal:Number(wholeMicros/1000000n+1n)};
}
function safeJson(raw,fallback){try{return typeof raw==='string'?JSON.parse(raw||''):raw}catch(_){return fallback;}}
function pmInkSettings(settings){
  const required=['pmprint_black_ink_rate','pmprint_color_ink_rate','pmprint_min_ink_charge','pmprint_coverage_threshold'];
  for(const key of required){if(settings[key]===undefined||settings[key]===null||clean(settings[key])==='')throw new Error(`PMPRINT pricing configuration is missing: ${key}.`);}
  const black=decimalToCents(settings.pmprint_black_ink_rate);
  const color=decimalToCents(settings.pmprint_color_ink_rate);
  const minimum=decimalToCents(settings.pmprint_min_ink_charge);
  const threshold=Number(settings.pmprint_coverage_threshold);
  if(!Number.isFinite(threshold)||threshold<0||threshold>100)throw new Error('PMPRINT coverage threshold is invalid.');
  return {blackInkRateCents:black,colorInkRateCents:color,minInkChargeCents:minimum,coverageThresholdPercent:threshold,roundingRule:'NEAREST_WHOLE_PESO_HALF_UP'};
}
function requirePmPrintingPricing(pricing){
  const keys=['text_bw','text_color','text_image_bw','text_image_color','image_bw','image_color','paper_per_sheet'];
  for(const key of keys){if(pricing[key]===undefined||pricing[key]===null||!Number.isFinite(Number(pricing[key]))||Number(pricing[key])<0)throw new Error(`PMPRINT pricing configuration is missing or invalid: ${key}.`);}
  return pricing;
}

function normalizeInkAnalysis(raw,pages){
  const rows=Array.isArray(raw)?raw:[];
  if(rows.length!==pages) throw new Error('Page-by-page ink analysis is incomplete. Please re-analyze the file.');
  return rows.map((p,i)=>{
    const pageNumber=Math.floor(num(p.page_number??p.pageNumber,i+1));
    if(pageNumber!==i+1) throw new Error('Invalid page analysis sequence.');
    const inkCategory=clean(p.ink_category||p.inkCategory||'Low');
    if(!['Low','Moderate','High','Very High','Partial'].includes(inkCategory)) throw new Error('Invalid ink category.');
    const blackUsage=Math.max(0,Math.min(1,num(p.black_usage_estimate??p.blackUsageEstimate,0)));
    const colorUsage=Math.max(0,Math.min(1,num(p.color_usage_estimate??p.colorUsageEstimate,0)));
    const total=Math.max(0,Math.min(1,num(p.ink_usage_estimate??p.inkUsageEstimate,blackUsage+colorUsage)));
    return {page_number:pageNumber,ink_category:inkCategory,coverage:Math.max(0,Math.min(1,num(p.coverage??p.visual_density??p.visualDensity,total))),black_usage_estimate:blackUsage,color_usage_estimate:colorUsage,cyan_coverage:num(p.cyan_coverage??p.cyanCoverage,0),magenta_coverage:num(p.magenta_coverage??p.magentaCoverage,0),yellow_coverage:num(p.yellow_coverage??p.yellowCoverage,0),ink_usage_estimate:total,black_coverage_ppm:Math.round(blackUsage*1000000),color_coverage_ppm:Math.round(colorUsage*1000000),visual_density:num(p.visual_density??p.visualDensity,total)};
  });
}
function calculatePmInk(settings,analysis,selectedPages,colorMode='Colored'){
  const selected=new Set(selectedPages&&selectedPages.length?selectedPages:analysis.map(p=>p.page_number));
  let blackRawCents=0,colorRawCents=0,totalRawCents=0;
  const pages=analysis.map(p=>{
    const included=selected.has(p.page_number);
    const blackPpm=colorMode==='Black & White'?Math.min(1000000,p.black_coverage_ppm+p.color_coverage_ppm):p.black_coverage_ppm;
    const colorPpm=colorMode==='Black & White'?0:p.color_coverage_ppm;
    const blackRaw=Number(settings.blackInkRateCents)*blackPpm/1000000;
    const colorRaw=Number(settings.colorInkRateCents)*colorPpm/1000000;
    const rawPageCents=Math.max(Number(settings.minInkChargeCents),blackRaw+colorRaw);
    if(included){blackRawCents+=blackRaw;colorRawCents+=colorRaw;totalRawCents+=rawPageCents;}
    return {...p,coverage:Math.max(0,Math.min(1,num(p.coverage??p.visual_density,0))),black_ink_cost:blackRaw/100,color_ink_cost:colorRaw/100,raw_ink_cost:rawPageCents/100,rounded_ink_cost:rawPageCents/100,included};
  });
  const totalRawPesos=totalRawCents/100;
  const roundedTotalInk=roundPesoHalfUpDecimalSafe(totalRawPesos);
  return {pages,blackInkCost:blackRawCents/100,colorInkCost:colorRawCents/100,totalInkCost:totalRawPesos,finalInkCost:roundedTotalInk};
}

async function ensurePmSchema(env){
  if(!env.PM_PRINT||!env.DB)return;

  // Existing PM PRINT databases may have been created before Account Management.
  // Never assume CREATE TABLE IF NOT EXISTS changes an existing table: it does not.
  // Ensure every required column exists BEFORE creating indexes or running account queries.
  const ensureColumn=async(table,column,type)=>{
    const info=await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const names=new Set((info.results||[]).map(r=>r.name));
    if(!names.has(column)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  };

  await env.DB.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY)").run();

  const orderColumns=[
    ['customer_id','TEXT'],
    ['checkout_id','TEXT'],
    ['ink_analysis_json',"TEXT DEFAULT ''"],
    ['pricing_snapshot_json',"TEXT DEFAULT ''"],
    ['automatic_ink_cost','REAL NOT NULL DEFAULT 0'],
    ['admin_ink_override','REAL'],
    ['final_ink_cost','REAL NOT NULL DEFAULT 0'],
    ['ink_price_source',"TEXT NOT NULL DEFAULT 'AUTOMATIC'"],
    ['file_hash',"TEXT DEFAULT ''"],
    ['subtotal','REAL NOT NULL DEFAULT 0'],
    ['centavo_discount','REAL NOT NULL DEFAULT 0'],
    ['final_total','REAL NOT NULL DEFAULT 0']
  ];
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, order_id TEXT, type TEXT NOT NULL DEFAULT 'printing', title TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, device_id TEXT DEFAULT '', customer_id TEXT, category TEXT NOT NULL DEFAULT 'printing')").run();
  for(const [name,type] of [['customer_id','TEXT'],['category',"TEXT NOT NULL DEFAULT 'printing'"]]) await ensureColumn('notifications',name,type);

  for(const [name,type] of orderColumns) await ensureColumn('orders',name,type);

  await env.DB.prepare("CREATE TABLE IF NOT EXISTS pm_customers (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', profile_picture_key TEXT DEFAULT '', bio TEXT DEFAULT '', gender TEXT DEFAULT '', birthday TEXT DEFAULT '', phone TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'Active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS pm_customer_sessions (token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, remember INTEGER NOT NULL DEFAULT 0)").run();
  await ensureColumn('pm_customer_sessions','customer_id',"TEXT NOT NULL DEFAULT ''");

  await env.DB.prepare("CREATE TABLE IF NOT EXISTS pm_account_activity (id TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', ip TEXT DEFAULT '', created_at TEXT NOT NULL)").run();
  await ensureColumn('pm_account_activity','customer_id','TEXT');
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_pm_account_activity_customer ON pm_account_activity(customer_id,created_at DESC)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_pm_account_activity_created ON pm_account_activity(created_at DESC)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_pm_customer_sessions_customer ON pm_customer_sessions(customer_id)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS pm_customer_vouchers (customer_id TEXT NOT NULL, voucher_code TEXT NOT NULL, assigned_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY(customer_id,voucher_code))").run();
  // Older PM PRINT deployments created this table with only customer_id/voucher_code.
  // Upgrade those existing tables in-place so voucher linking never fails on a
  // missing timestamp column. SQLite ADD COLUMN is safe here because the
  // columns are added only when PRAGMA table_info confirms they are absent.
  const voucherCols=await env.DB.prepare("PRAGMA table_info(pm_customer_vouchers)").all();
  const voucherNames=new Set((voucherCols.results||[]).map(r=>r.name));
  if(!voucherNames.has('assigned_at')) await env.DB.prepare("ALTER TABLE pm_customer_vouchers ADD COLUMN assigned_at TEXT NOT NULL DEFAULT ''").run();
  if(!voucherNames.has('created_at')) await env.DB.prepare("ALTER TABLE pm_customer_vouchers ADD COLUMN created_at TEXT NOT NULL DEFAULT ''").run();
  if(!voucherNames.has('updated_at')) await env.DB.prepare("ALTER TABLE pm_customer_vouchers ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_pm_customer_vouchers_customer ON pm_customer_vouchers(customer_id)").run();

  const defaults=[['pmprint_black_ink_rate','0.50'],['pmprint_color_ink_rate','1.00'],['pmprint_min_ink_charge','0.01'],['pmprint_coverage_threshold','5'],['service_message','Printing orders are temporarily unavailable. Please check again later.'],['pmprint_account_management','0']];
  const t=now();for(const [k,v] of defaults)await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING").bind(k,v,t).run();
}
async function sha256(text){const b=new TextEncoder().encode(text);const h=await crypto.subtle.digest('SHA-256',b);return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function sha256Bytes(bytes){const h=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function passwordHash(password, secret=''){return sha256(`${secret}|${password}`);}
function cookie(name,value,opts={}){let s=`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;if(opts.maxAge!==undefined)s+=`; Max-Age=${opts.maxAge}`;if(opts.secure!==false)s+='; Secure';return s;}
function getCookie(req,name){const c=req.headers.get('Cookie')||'';for(const p of c.split(';')){const [k,...rest]=p.trim().split('=');if(k===name)return decodeURIComponent(rest.join('='));}return '';}
async function requireAdmin(env,req){const token=getCookie(req,env.ADMIN_COOKIE||'bsais_admin');if(!token)throw new Error('Administrator login required.');const h=await sha256(token);const row=await env.DB.prepare('SELECT * FROM sessions WHERE token_hash=? AND (expires_at>? OR expires_at=?)').bind(h,now(),'9999-12-31T23:59:59.999Z').first();if(!row)throw new Error('Your admin session is invalid. Please log in again.');return row;}
async function log(env,user,action,description){try{await env.DB.prepare('INSERT INTO activity_log(id,username,action,description,timestamp) VALUES(?,?,?,?,?)').bind(id('LOG'),user||'',action,description||'',now()).run();}catch(_){} }
async function accountPasswordHash(password,salt){let data=new TextEncoder().encode(`${salt}|${password}`);let key=await crypto.subtle.importKey('raw',data,'PBKDF2',false,['deriveBits']);let bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},key,256);return [...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function accountActivity(env,c,action,description,req){try{await env.DB.prepare('INSERT INTO pm_account_activity(id,customer_id,username,action,description,ip,created_at) VALUES(?,?,?,?,?,?,?)').bind(id('AA'),c?.id||null,c?.username||'',action,description||'',req?.headers.get('CF-Connecting-IP')||'',now()).run();}catch(_){} }
async function requireCustomer(env,req){const token=getCookie(req,'pmprint_customer');if(!token)throw new Error('Customer login required.');const h=await sha256(token);const row=await env.DB.prepare('SELECT c.* FROM pm_customer_sessions s INNER JOIN pm_customers c ON c.id=s.customer_id WHERE s.token_hash=? AND s.expires_at>?').bind(h,now()).first();if(!row||row.status!=='Active')throw new Error('Your customer session is invalid or your account is inactive.');return row;}
function publicCustomer(c){return c?{id:c.id,username:c.username,name:c.name,phone:c.phone||'',gender:c.gender||'',birthday:c.birthday||'',bio:c.bio||'',status:c.status,createdAt:c.created_at,updatedAt:c.updated_at}:null;}
async function accountManagementOn(env){const s=await getSettings(env);return s.pmprint_account_management==='1'||s.pmprint_account_management==='true';}
async function customerSessionResponse(env,req,c,remember=false){const token=crypto.randomUUID()+crypto.randomUUID(),th=await sha256(token),days=remember?30:1,exp=new Date(Date.now()+days*86400000).toISOString();await env.DB.prepare('INSERT INTO pm_customer_sessions(token_hash,customer_id,created_at,expires_at,remember) VALUES(?,?,?,?,?)').bind(th,c.id,now(),exp,remember?1:0).run();await accountActivity(env,c,'LOGIN','Customer signed in.',req);return json({success:true,customer:publicCustomer(c),accountManagement:true},200,{'set-cookie':cookie('pmprint_customer',token,{maxAge:remember?days*86400:86400})});}
async function adminCustomers(env,search='',status=''){let sql='SELECT id,username,name,phone,gender,birthday,status,created_at,updated_at FROM pm_customers WHERE 1=1';const args=[];if(search){sql+=' AND (name LIKE ? OR username LIKE ? OR phone LIKE ?)';const q=`%${search}%`;args.push(q,q,q)}if(status){sql+=' AND status=?';args.push(status)}sql+=' ORDER BY created_at DESC LIMIT 500';const {results}=await env.DB.prepare(sql).bind(...args).all();return results;}


function rowOrder(r,origin='',apiPrefix='/api'){
  return {OrderID:r.id,StudentName:r.customer_name,Contact:r.contact,Fulfillment:r.fulfillment,Location:r.location,DeliveryFee:num(r.delivery_fee),Notes:r.delivery_notes||'',ContentType:r.content_type,Color:r.print_color,Sides:r.print_side,Format:r.format,PaperSize:r.paper_size,Copies:num(r.copies,1),Binding:r.binding||'',FileName:r.file_name||'',FileLink:r.r2_key?`${origin}${apiPrefix}/admin/file?orderId=${encodeURIComponent(r.id)}`:'',Pages:num(r.pages),PageSelection:r.page_selection||'',PrintedSides:num(r.printed_sides),Sheets:num(r.sheets),PrintingCost:num(r.printing_cost),PaperCost:num(r.paper_cost),Total:num(r.amount),Status:r.status,PaymentStatus:r.payment_status||'Payment Due',UpdatedAt:r.updated_at,CreatedAt:r.created_at,StatusReason:r.status_reason||'',ReadyPickupLocation:r.ready_pickup_location||'',VoucherCode:r.voucher_code||'',Discount:num(r.discount),Subtotal:num(r.subtotal),CentavoDiscount:num(r.centavo_discount),FinalTotal:num(r.final_total||r.amount),InkAnalysis:safeJson(r.ink_analysis_json,[]),PricingSnapshot:safeJson(r.pricing_snapshot_json,{}),AutomaticInkCost:num(r.automatic_ink_cost),AdminInkOverride:r.admin_ink_override===null||r.admin_ink_override===undefined?null:num(r.admin_ink_override),FinalInkCost:num(r.final_ink_cost),InkPriceSource:r.ink_price_source||'AUTOMATIC'};
}
async function getPricing(env){const {results}=await env.DB.prepare('SELECT key,value FROM pricing').all();const p={};for(const r of results)p[r.key]=num(r.value);return p;}
async function getSettings(env){const {results}=await env.DB.prepare('SELECT key,value FROM settings').all();const s={};for(const r of results)s[r.key]=r.value;return s;}
async function getLocations(env,activeOnly=true){const q=activeOnly?'SELECT * FROM locations WHERE active=1 ORDER BY name':'SELECT * FROM locations ORDER BY name';const {results}=await env.DB.prepare(q).all();return results;}
function calculatePrice(p,pages,copies,content,color,sides,format){let rate;if(content==='Text Only')rate=color==='Colored'?p.text_color:p.text_bw;else if(content==='Text + Image')rate=color==='Colored'?p.text_image_color:p.text_image_bw;else if(content==='Image Only')rate=color==='Colored'?p.image_color:p.image_bw;else throw new Error('Invalid content type.');let sheets,printedSides;if(format==='Booklet'){if(pages<=1){sheets=1;printedSides=1}else if(pages<=4){sheets=1;printedSides=2}else if(pages===5){sheets=2;printedSides=3}else{sheets=Math.ceil(pages/2);printedSides=Math.ceil((pages+1)/2)}}else{printedSides=sides==='Single-sided'?pages:Math.ceil(pages/2);sheets=sides==='Single-sided'?pages:Math.max(1,Math.ceil(pages/2));}return {sheets:sheets*copies,printedSides:printedSides*copies,paperCost:sheets*copies*p.paper_per_sheet,printingCost:printedSides*copies*rate,baseTotal:sheets*copies*p.paper_per_sheet+printedSides*copies*rate};}
async function validateVoucherServer(env,{code,subtotal,pages,copies,deliveryFee,deviceId,consume=false,orderId='',customerId=null,accountManaged=false}){
  code=clean(code).toUpperCase();if(!code)return {discount:0,voucher:null};
  const v=await env.DB.prepare('SELECT * FROM vouchers WHERE code=? AND active=1').bind(code).first();if(!v)throw new Error('Voucher code is invalid or inactive.');
  const t=Date.now();if(v.start_at&&new Date(v.start_at).getTime()>t)throw new Error('This voucher is not active yet.');if(v.end_at&&new Date(v.end_at).getTime()<t)throw new Error('This voucher has expired.');
  if(subtotal < num(v.min_spend))throw new Error(`Minimum spend of ₱${num(v.min_spend).toFixed(2)} is required.`);
  if(num(v.min_pages)>0&&pages<num(v.min_pages))throw new Error(`Minimum ${v.min_pages} pages are required.`);
  if(num(v.min_copies)>0&&copies<num(v.min_copies))throw new Error(`Minimum ${v.min_copies} copies are required.`);
  if(v.total_usage_limit!==null){const c=await env.DB.prepare('SELECT COUNT(*) c FROM voucher_redemptions WHERE voucher_code=?').bind(code).first();if(num(c?.c)>=num(v.total_usage_limit))throw new Error('This voucher has reached its usage limit.');}
  if(deviceId&&num(v.per_device_limit)>0){const c=await env.DB.prepare('SELECT COUNT(*) c FROM voucher_redemptions WHERE voucher_code=? AND device_id=?').bind(code,deviceId).first();if(num(c?.c)>=num(v.per_device_limit))throw new Error('You have already used this voucher on this device.');}
  let discount=0;
  if(v.type==='percent')discount=subtotal*(num(v.value)/100);else if(v.type==='fixed')discount=num(v.value);else if(v.type==='free_shipping')discount=Math.min(num(deliveryFee),v.max_shipping_discount===null?num(deliveryFee):num(v.max_shipping_discount));
  if(v.max_discount!==null&&v.type!=='free_shipping')discount=Math.min(discount,num(v.max_discount));
  discount=Math.min(subtotal+deliveryFee,Math.max(0,discount));
  return {discount:Number(discount.toFixed(2)),voucher:{code,type:v.type,value:num(v.value),label:v.type==='percent'?`${num(v.value)}% OFF`:v.type==='fixed'?`₱${num(v.value).toFixed(2)} OFF`:'FREE DELIVERY'}};
}


async function validateVouchersServer(env,{codes,subtotal,pages,copies,deliveryFee,deviceId,customerId=null,accountManaged=false}){
  const list=[...new Set((Array.isArray(codes)?codes:String(codes||'').split(',')).map(x=>clean(x).toUpperCase()).filter(Boolean))];
  if(!list.length) return {discount:0,vouchers:[],codes:[],printDiscount:0,shippingDiscount:0};
  const vouchers=[];let printDiscount=0,shippingDiscount=0,shippingCount=0;
  for(const code of list){
    const v=await validateVoucherServer(env,{code,subtotal,pages,copies,deliveryFee,deviceId,customerId,accountManaged});
    if(!v.voucher) continue;
    const type=v.voucher.type;
    if(type==='free_shipping'){
      shippingCount++;
      if(shippingCount>1) throw new Error('Only one shipping voucher can be used at a time.');
      shippingDiscount=v.discount;
    }else{
      printDiscount+=v.discount;
    }
    vouchers.push({...v.voucher,discount:v.discount});
  }
  const discount=Math.min(subtotal+deliveryFee,Math.max(0,Number((printDiscount+shippingDiscount).toFixed(2))));
  return {discount,vouchers,codes:vouchers.map(v=>v.code),printDiscount:Number(printDiscount.toFixed(2)),shippingDiscount:Number(shippingDiscount.toFixed(2))};
}


function notificationForStatus(status, reason='', pickup='', orderId=''){
  const s=clean(status);
  const ref=orderId?`Order ${orderId}`:'Your printing order';
  if(s==='Accepted') return {type:'accepted',title:'Order accepted',message:`${ref} has been accepted.`};
  if(s==='Declined') return {type:'declined',title:'Order declined',message:reason?`${ref} was declined: ${reason}`:`${ref} was declined.`};
  if(s==='Printing') return {type:'printing',title:'Order is printing',message:`${ref} is now being printed.`};
  if(s==='Completed') return {type:'completed',title:'Printing completed',message:`${ref} has been completed.`};
  if(s==='In Transit') return {type:'transit',title:'Order in transit',message:`${ref} is on the way.`};
  if(s==='Ready to Pickup') return {type:'pickup',title:'Ready for pickup',message:pickup?`${ref} is ready for pickup at ${pickup}.`:`${ref} is ready for pickup.`};
  if(s==='Delivered') return {type:'delivered',title:'Order delivered',message:`${ref} has been delivered.`};
  return {type:'order',title:'Order received',message:`${ref} has been received.`};
}
async function createOrderNotification(env,orderId,deviceId,status,reason='',pickup='',customerId=null){
  if(!clean(orderId)) return;
  const n=notificationForStatus(status,reason,pickup,orderId),t=now();
  if(clean(customerId)){
    const existing=await env.DB.prepare("SELECT id FROM notifications WHERE order_id=? AND customer_id=? ORDER BY created_at DESC LIMIT 1").bind(orderId,customerId).first();
    if(existing){
      await env.DB.prepare('UPDATE notifications SET type=?,category=?,title=?,message=?,created_at=?,read_at=NULL,device_id=? WHERE id=?').bind(n.type,'printing',n.title,n.message,t,clean(deviceId),existing.id).run();
    }else{
      await env.DB.prepare('INSERT INTO notifications(id,order_id,type,title,message,created_at,read_at,device_id,customer_id,category) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id('NOT'),orderId,n.type,n.title,n.message,t,null,clean(deviceId),customerId,'printing').run();
    }
    return;
  }
  if(!clean(deviceId)) return;
  const existing=await env.DB.prepare('SELECT id FROM notifications WHERE order_id=? AND device_id=? ORDER BY created_at DESC LIMIT 1').bind(orderId,deviceId).first();
  if(existing){
    await env.DB.prepare('UPDATE notifications SET type=?,title=?,message=?,created_at=?,read_at=NULL WHERE id=?').bind(n.type,n.title,n.message,t,existing.id).run();
  }else{
    await env.DB.prepare('INSERT INTO notifications(id,order_id,type,title,message,created_at,read_at,device_id,category) VALUES(?,?,?,?,?,?,?,?,?)').bind(id('NOT'),orderId,n.type,n.title,n.message,t,null,clean(deviceId),'printing').run();
  }
}
async function createCustomerNotification(env,customerId,{type='system',category='system',title,message,orderId=null}){
  if(!clean(customerId)||!clean(title)||!clean(message)) return;
  await env.DB.prepare('INSERT INTO notifications(id,order_id,type,title,message,created_at,read_at,device_id,customer_id,category) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id('NOT'),clean(orderId)||'',clean(type),clean(title),clean(message),now(),null,'',clean(customerId),clean(category)||'system').run();
}


function parsePageSelectionServer(raw,total){const text=clean(raw);if(!text)return {valid:true,count:total,pages:[]};const max=Math.max(0,Math.floor(num(total)));const set=new Set();for(const part of text.split(',')){const m=part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);if(!m)throw new Error('Invalid page selection.');let a=Number(m[1]),b=m[2]?Number(m[2]):a;if(a<1||b<a||b>max)throw new Error('Page selection is outside the analyzed page range.');for(let i=a;i<=b;i++)set.add(i);}return {valid:set.size>0,count:set.size,pages:[...set].sort((a,b)=>a-b)};}
async function createOrder(env,data,origin,apiPrefix='/api',request=null,options={}){
  const settings=await getSettings(env); if(settings.printing_available==='false')throw new Error('Printing orders are currently unavailable.');
  const accountsOn=settings.pmprint_account_management==='1'||settings.pmprint_account_management==='true';
  let account=null;if(accountsOn){account=await requireCustomer(env,request||new Request(origin));data.studentName=account.name;data.contact=account.phone||clean(data.contact);if(!data.contact)throw new Error('Your account does not have a contact number. Please ask the administrator to update your account.');data.customerId=account.id;}

  const internal=options.internal===true;
  const incomingR2Key=clean(data.r2Key);
  const uploadedFile=data.uploadedFile instanceof File ? data.uploadedFile : null;
  if(env.PM_PRINT && !uploadedFile && !incomingR2Key) throw new Error('The document file is required.');
  if(uploadedFile){
    const uploadedName=String(uploadedFile.name||'').toLowerCase();
    const uploadedType=String(uploadedFile.type||'').toLowerCase();
    const unsupportedOffice=/\.(doc|docx|ppt|pptx)$/.test(uploadedName)||/application\/(msword|vnd\.ms-powerpoint)/.test(uploadedType)||/application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation)/.test(uploadedType);
    if(unsupportedOffice) throw new Error('Word and PowerPoint files are not accepted. Please convert the file to PDF first because fonts, margins, or layout may change.');
    const supportedPdf=uploadedName.endsWith('.pdf')||uploadedType==='application/pdf';
    const supportedImage=/\.(jpg|jpeg|png|webp|gif|bmp)$/.test(uploadedName)||uploadedType.startsWith('image/');
    if(!supportedPdf&&!supportedImage) throw new Error('Unsupported file type. Please upload a PDF or image file.');
  }
  const student=clean(data.studentName),contact=clean(data.contact);if(!student)throw new Error('Student name is required.');if(!contact)throw new Error('Contact information is required.');
  const fulfillment=clean(data.fulfillment||'Pickup');if(!['Pickup','Delivery'].includes(fulfillment))throw new Error('Invalid order method.');
  const pages=Math.floor(num(data.pages));const pageSelection=clean(data.pageSelection);if(pageSelection&&!/^(?:\d+(?:-\d+)?)(?:,\s*\d+(?:-\d+)?)*$/.test(pageSelection))throw new Error('Invalid page selection.');const copies=Math.floor(num(data.copies,1));if(pages<1)throw new Error('A valid page count is required.');if(copies<1||copies>1000)throw new Error('Copies must be between 1 and 1000.');
  let content=clean(data.contentType),color=clean(data.color),sides=clean(data.sides),format=clean(data.format),paper=clean(data.paperSize),binding=clean(data.binding);if(format==='Booklet')sides='Double-sided';
  if(!['Text Only','Text + Image','Image Only'].includes(content))throw new Error('Invalid content type.');if(!['Black & White','Colored'].includes(color))throw new Error('Invalid print color.');if(!['Single-sided','Double-sided','Back-to-back'].includes(sides))throw new Error('Invalid print side.');if(!['Regular','Booklet','Tarpapel'].includes(format))throw new Error('Invalid print format.');if(!paper)throw new Error('Paper size is required.');
  const pricing=await getPricing(env);if(env.PM_PRINT)requirePmPrintingPricing(pricing);const calc=calculatePrice(pricing,pages,copies,content,color,sides,format);
  let location='',deliveryFee=0;
  if(fulfillment==='Pickup'){
    const currentPickup=clean(settings.pickup_location); const oldDefault='Pinoma National High School - PM PRINT'; const oldWorkerDefault='New Building - CBM, 4th Floor, Room 405';
    if(env.PM_PRINT && (!currentPickup || currentPickup===oldDefault || currentPickup===oldWorkerDefault)){location='Yao St., Purok 5, Naganacan, Cauayan City, Isabela';try{await env.DB.prepare("INSERT INTO settings(key,value) VALUES('pickup_location',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(location).run();}catch(_){}}else location=currentPickup||oldWorkerDefault;
  } else {
    const locationId=clean(data.locationId);
    const submittedLocationName=clean(data.location);
    let loc=null;
    if(locationId)loc=await env.DB.prepare('SELECT * FROM locations WHERE id=? AND active=1').bind(locationId).first();
    if(!loc&&submittedLocationName)loc=await env.DB.prepare('SELECT * FROM locations WHERE name=? AND active=1').bind(submittedLocationName).first();
    if(!loc)throw new Error('Selected delivery location is no longer available.');
    location=loc.name;
    deliveryFee=num(loc.fee);
  }
  const deviceId=clean(data.deviceId);let discount=0,voucherCode='';let voucherInfo=null;let voucherCodes=[];
  const requestedVoucherCodes=Array.isArray(data.voucherCodes)?data.voucherCodes:(clean(data.voucherCode)?String(data.voucherCode).split(','):[]);
  if(internal&&data._voucherValidated){
    discount=Math.max(0,Number(data._voucherDiscount||0));
    voucherCodes=[...new Set((Array.isArray(data._voucherCodes)?data._voucherCodes:[]).map(x=>clean(x).toUpperCase()).filter(Boolean))];
    voucherCode=voucherCodes.join(', ');
    voucherInfo=Array.isArray(data._voucherInfo)?data._voucherInfo:[];
  }else if(requestedVoucherCodes.length){const vr=await validateVouchersServer(env,{codes:requestedVoucherCodes,subtotal:calc.baseTotal,pages,copies,deliveryFee,deviceId,customerId:account?.id||null,accountManaged:accountsOn});discount=vr.discount;voucherCodes=vr.codes;voucherCode=vr.codes.join(', ');voucherInfo=vr.vouchers;}
  const settingsInk=pmInkSettings(settings);
  const analysis=normalizeInkAnalysis(data.inkAnalysis,pages);
  const selection=parsePageSelectionServer(pageSelection,pages);
  const ink=calculatePmInk(settingsInk,analysis,selection.pages.length?selection.pages:analysis.map(p=>p.page_number),color);
  const automaticInkPerCopy=ink.totalInkCost;
  const rawTotalInk=automaticInkPerCopy*copies;
  const adminOverride=(data.adminInkOverride!==undefined&&data.adminInkOverride!==null&&clean(data.adminInkOverride)!=='')?clean(data.adminInkOverride):null;
  if(adminOverride!==null)throw new Error('Admin ink override is not accepted during customer order creation.');
  // Additional Ink Usage is a real charge and stays separate from the centavo adjustment.
  // Keep the calculated ink amount precise through the subtotal; only the complete
  // applicable amount is rounded at the .50 boundary. This prevents the ink charge
  // from being mistaken for, or replaced by, the Centavo Discount.
  const finalInk=rawTotalInk;
  // Keep totalInk as the authoritative PMPRINT ink amount used by the
  // order/analysis payload and database snapshot. The Automatic Analysis UI
  // may hide the price, but the underlying calculated ink charge remains live.
  const totalInk=finalInk;
  const grossSubtotal=calc.baseTotal+deliveryFee+finalInk;
  const subtotal=Math.max(0,grossSubtotal-discount);
  const adjustment=wholePesoAdjustment(subtotal);
  const centavoDiscount=adjustment.discount;
  const total=adjustment.finalTotal;
  const orderId=env.PM_PRINT?`PM-${crypto.randomUUID().replace(/-/g,'').slice(0,4).toUpperCase()}`:`${String(new Date().getFullYear()).slice(-2)}-${crypto.randomUUID().replace(/-/g,'').slice(0,4).toUpperCase()}`;const created=now();
  let permanentKey=incomingR2Key;
  if(env.PM_PRINT){
    if(uploadedFile){
      if(uploadedFile.size>MAX_UPLOAD_BYTES)throw new Error('File is larger than 20 MB. Please choose a file up to 20 MB.');
      const safe=String(data.fileName||uploadedFile.name||'document').replace(/[^A-Za-z0-9._-]/g,'_');
      permanentKey=`pmprint/orders/${created.slice(0,4)}/${orderId}/${safe}`;
      try{
        const bytes=await uploadedFile.arrayBuffer();
        const actualHash=await sha256Bytes(bytes);
        if(clean(data.fileHash)&&actualHash!==clean(data.fileHash))throw new Error('The selected file changed after analysis. Please select it again.');
        await env.PRINT_FILES.put(permanentKey,bytes,{httpMetadata:{contentType:clean(data.fileType)||uploadedFile.type||'application/octet-stream'},customMetadata:{customerName:student,orderId,fileHash:actualHash}});
        data.fileHash=actualHash;
      }catch(e){ if(String(e?.message||'').includes('changed after analysis'))throw e; throw new Error('Unable to upload your document. Please try again.'); }
    }else if(incomingR2Key.startsWith('pmprint/cart/')){
      const cartObject=await env.PRINT_FILES.get(incomingR2Key);
      if(!cartObject)throw new Error('The cart file is no longer available. Please add the item to cart again.');
      permanentKey=`pmprint/orders/${created.slice(0,4)}/${orderId}/${String(data.fileName||'document').replace(/[^A-Za-z0-9._-]/g,'_')}`;
      await env.PRINT_FILES.put(permanentKey,cartObject.body,{httpMetadata:{contentType:clean(data.fileType)||'application/octet-stream'},customMetadata:{customerName:student,orderId,fileHash:clean(data.fileHash)}});
    }else if(!incomingR2Key.startsWith('pmprint/orders/')){
      throw new Error('A valid PMPRINT order file is required.');
    }
  }
  const snapshot={black_ink_rate:centsToNumber(settingsInk.blackInkRateCents),color_ink_rate:centsToNumber(settingsInk.colorInkRateCents),minimum_ink_charge:centsToNumber(settingsInk.minInkChargeCents),coverage_threshold_percent:settingsInk.coverageThresholdPercent,raw_additional_ink_cost:rawTotalInk,final_additional_ink_cost:finalInk,gross_subtotal:grossSubtotal,subtotal,centavo_discount:centavoDiscount,voucher_discount:discount,final_total:total,pricing_source:'ADMIN_CONFIGURED',snapshot_timestamp:now(),rounding_rule:'CENTAVO_DISCOUNT_BELOW_0.50_ELSE_ROUND_UP'};
  const analysisPayload={page_count:pages,selected_pages:selection.pages.length?selection.pages:analysis.map(p=>p.page_number),ink_per_copy:automaticInkPerCopy,total_ink_cost:totalInk,raw_additional_ink_cost:rawTotalInk,final_additional_ink_cost:finalInk,gross_subtotal:grossSubtotal,subtotal,centavo_discount:centavoDiscount,voucher_discount:discount,final_total:total,pages:ink.pages,analyzed_at:now()};
  try{
    await env.DB.prepare(`INSERT INTO orders(id,customer_name,contact,location,content_type,print_color,print_side,format,paper_size,copies,binding,file_name,r2_key,fulfillment,delivery_fee,delivery_notes,pages,page_selection,printed_sides,sheets,printing_cost,paper_cost,amount,payment_status,status,status_reason,ready_pickup_location,voucher_code,discount,created_at,updated_at,device_id,ink_analysis_json,pricing_snapshot_json,automatic_ink_cost,admin_ink_override,final_ink_cost,ink_price_source,file_hash,subtotal,centavo_discount,final_total,customer_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(orderId,student,contact,location,content,color,sides,format,paper,copies,binding,clean(data.fileName),permanentKey,fulfillment,deliveryFee,clean(data.notes),pages,pageSelection,calc.printedSides,calc.sheets,calc.printingCost,calc.paperCost,total,'Payment Due','Pending','',fulfillment==='Pickup'?location:'',voucherCode,discount,created,created,deviceId,JSON.stringify(analysisPayload),JSON.stringify(snapshot),totalInk,finalInk,finalInk,'AUTOMATIC',clean(data.fileHash),subtotal,centavoDiscount,total,account?.id||null).run();
  }catch(e){ if(env.PM_PRINT&&permanentKey.startsWith('pmprint/orders/')){try{await env.PRINT_FILES.delete(permanentKey);}catch(_){}} throw e; }
  if(env.PM_PRINT&&incomingR2Key.startsWith('pmprint/cart/')){try{await env.PRINT_FILES.delete(incomingR2Key)}catch(_){}}
  await createOrderNotification(env,orderId,deviceId,'Pending','',fulfillment==='Pickup'?location:'',account?.id||null);
  if(voucherCodes.length&&!internal){const vr=await validateVouchersServer(env,{codes:voucherCodes,subtotal:calc.baseTotal,pages,copies,deliveryFee,deviceId,customerId:account?.id||null,accountManaged:accountsOn});for(const v of vr.vouchers)await env.DB.prepare('INSERT INTO voucher_redemptions(id,voucher_code,device_id,order_id,discount,created_at) VALUES(?,?,?,?,?,?)').bind(id('VR'),v.code,deviceId,orderId,v.discount,created).run();}
  const row=await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first(); return {success:true,order:rowOrder(row,origin,apiPrefix),voucher:voucherInfo};
}
async function adminOrders(env,status,origin,limit=100,apiPrefix='/api'){let sql='SELECT * FROM orders';const args=[];if(status){sql+=' WHERE status=?';args.push(status)}else{sql+=` WHERE status IN (${ACTIVE_ORDER_STATUSES.map(()=>'?').join(',')})`;args.push(...ACTIVE_ORDER_STATUSES)}sql+=' ORDER BY created_at DESC LIMIT ?';args.push(Math.min(200,Math.max(1,num(limit,100))));const {results}=await env.DB.prepare(sql).bind(...args).all();return results.map(r=>rowOrder(r,origin,apiPrefix));}
async function updateOrder(env,ids,status,reason,user){
  if(!ALL_ORDER_STATUSES.includes(status))throw new Error('Invalid order status.');
  if(status==='Declined'&&!clean(reason))throw new Error('A reason is required when declining an order.');
  let updated=0;
  for(const oid of ids){
    const before=await env.DB.prepare('SELECT id,device_id,status,customer_id FROM orders WHERE id=?').bind(oid).first();
    if(!before)continue;
    const pickup=status==='Ready to Pickup'?(await getSettings(env)).pickup_location:'';
    const r=await env.DB.prepare('UPDATE orders SET status=?,status_reason=?,ready_pickup_location=?,updated_at=? WHERE id=?').bind(status,clean(reason),pickup,now(),oid).run();
    updated+=r.meta.changes||0;
    if((r.meta.changes||0)>0 && clean(before.device_id) && clean(before.status)!==status){
      await createOrderNotification(env,oid,before.device_id,status,reason,pickup,before.customer_id||null);
    }
  }
  await log(env,user.username,'BULK_STATUS_UPDATE',`${updated} order(s) → ${status}`);
  return {success:true,updated};
}

async function handleAdmin(env,req,action,data,origin,apiPrefix='/api'){const user=await requireAdmin(env,req);
  if(action==='getAccountSettings'){const on=await accountManagementOn(env);const c=await env.DB.prepare('SELECT COUNT(*) c FROM pm_customers').first();return {success:true,accountManagement:on,totalCustomers:num(c?.c)};}
  if(action==='setAccountManagement'){const on=!!data.enabled;await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('pmprint_account_management',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(on?'1':'0',now()).run();await log(env,user.username,'ACCOUNT_MANAGEMENT_'+(on?'ON':'OFF'),`Customer Account Management turned ${on?'ON':'OFF'}.`);return {success:true,accountManagement:on};}
  if(action==='getCustomerAccounts')return {success:true,accounts:await adminCustomers(env,clean(data.search),clean(data.status))};
  if(action==='createCustomerAccount'){const name=clean(data.name),username=clean(data.username).toLowerCase(),password=String(data.password||'');if(!name)throw new Error('Full Name is required.');if(!/^[A-Za-z0-9._%+@-]{3,80}$/.test(username)||username.startsWith('@')||username.endsWith('@')||username.includes('@@'))throw new Error('Username must be 3–80 characters and may use letters, numbers, dot, underscore, hyphen, plus, percent or @.');if(password.length<8)throw new Error('Password must be at least 8 characters.');const exists=await env.DB.prepare('SELECT id FROM pm_customers WHERE username=?').bind(username).first();if(exists)throw new Error('That username is already in use.');const salt=crypto.randomUUID()+crypto.randomUUID(),hash=await accountPasswordHash(password,salt),cid=id('CUS');await env.DB.prepare('INSERT INTO pm_customers(id,username,password_hash,password_salt,name,bio,gender,birthday,phone,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(cid,username,hash,salt,name,clean(data.bio),clean(data.gender),clean(data.birthday),clean(data.phone),data.status==='Inactive'?'Inactive':'Active',now(),now()).run();await accountActivity(env,{id:cid,username},'ACCOUNT_CREATED',`Account created by administrator for ${name}.`,req);await log(env,user.username,'CUSTOMER_ACCOUNT_CREATED',`Created customer account ${username}.`);return {success:true,account:(await adminCustomers(env,username,''))[0]};}
  if(action==='updateCustomerAccount'){const cid=clean(data.id),name=clean(data.name),username=clean(data.username).toLowerCase();if(!cid||!name||!username)throw new Error('Account ID, Full Name and Username are required.');const old=await env.DB.prepare('SELECT * FROM pm_customers WHERE id=?').bind(cid).first();if(!old)throw new Error('Customer account not found.');const dupe=await env.DB.prepare('SELECT id FROM pm_customers WHERE username=? AND id<>?').bind(username,cid).first();if(dupe)throw new Error('That username is already in use.');await env.DB.prepare('UPDATE pm_customers SET username=?,name=?,phone=?,gender=?,birthday=?,bio=?,status=?,updated_at=? WHERE id=?').bind(username,name,clean(data.phone),clean(data.gender),clean(data.birthday),clean(data.bio),data.status==='Inactive'?'Inactive':'Active',now(),cid).run();if(data.status==='Inactive')await env.DB.prepare('DELETE FROM pm_customer_sessions WHERE customer_id=?').bind(cid).run();await accountActivity(env,{id:cid,username},'ACCOUNT_UPDATED','Account details updated by administrator.',req);await log(env,user.username,'CUSTOMER_ACCOUNT_UPDATED',`Updated customer account ${username}.`);return {success:true};}
  if(action==='deleteCustomerAccount'){const cid=clean(data.id),c=await env.DB.prepare('SELECT * FROM pm_customers WHERE id=?').bind(cid).first();if(!c)throw new Error('Customer account not found.');await env.DB.prepare('DELETE FROM pm_customer_vouchers WHERE customer_id=?').bind(cid).run();await env.DB.prepare('DELETE FROM pm_customer_sessions WHERE customer_id=?').bind(cid).run();await env.DB.prepare('DELETE FROM notifications WHERE customer_id=?').bind(cid).run();await env.DB.prepare('UPDATE orders SET customer_id=NULL WHERE customer_id=?').bind(cid).run();await accountActivity(env,c,'ACCOUNT_DELETED','Account deleted by administrator.',req);await env.DB.prepare('DELETE FROM pm_customers WHERE id=?').bind(cid).run();await log(env,user.username,'CUSTOMER_ACCOUNT_DELETED',`Deleted customer account ${c.username}.`);return {success:true};}
  if(action==='resetCustomerPassword'){const cid=clean(data.id),password=String(data.password||'');if(password.length<8)throw new Error('Password must be at least 8 characters.');const c=await env.DB.prepare('SELECT * FROM pm_customers WHERE id=?').bind(cid).first();if(!c)throw new Error('Customer account not found.');const salt=crypto.randomUUID()+crypto.randomUUID(),hash=await accountPasswordHash(password,salt);await env.DB.prepare('UPDATE pm_customers SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').bind(hash,salt,now(),cid).run();await env.DB.prepare('DELETE FROM pm_customer_sessions WHERE customer_id=?').bind(cid).run();await accountActivity(env,c,'PASSWORD_RESET','Password reset by administrator.',req);await log(env,user.username,'CUSTOMER_PASSWORD_RESET',`Reset password for ${c.username}.`);return {success:true};}
  if(action==='getCustomerActivity'){const cid=clean(data.customerId),q=clean(data.search);let sql='SELECT id,customer_id,username,action,description,ip,created_at FROM pm_account_activity WHERE 1=1';const args=[];if(cid){sql+=' AND customer_id=?';args.push(cid)}if(q){sql+=' AND (username LIKE ? OR action LIKE ? OR description LIKE ?)';const x=`%${q}%`;args.push(x,x,x)}sql+=' ORDER BY created_at DESC LIMIT 500';const {results}=await env.DB.prepare(sql).bind(...args).all();return {success:true,activity:results};}
  if(action==='pushNotification'){
    const target=clean(data.target||'all').toLowerCase(),title=clean(data.title).slice(0,120),message=clean(data.message).slice(0,1000);
    if(!title)throw new Error('Notification title is required.');
    if(!message)throw new Error('Notification message is required.');
    let customers=[];
    if(target==='customer'){
      const cid=clean(data.customerId);if(!cid)throw new Error('Select a customer.');
      const c=await env.DB.prepare('SELECT id,username,name,status FROM pm_customers WHERE id=?').bind(cid).first();if(!c||c.status!=='Active')throw new Error('Active customer account not found.');customers=[c];
    }else{
      const r=await env.DB.prepare("SELECT id,username,name,status FROM pm_customers WHERE status='Active' ORDER BY name COLLATE NOCASE").all();customers=r.results||[];
    }
    for(const c of customers)await createCustomerNotification(env,c.id,{type:'system',category:'system',title,message});
    await log(env,user.username,'PUSH_NOTIFICATION',`Sent notification to ${customers.length} customer account(s): ${title}`);
    return {success:true,sent:customers.length};
  }
  if(action==='getAdminDashboard'){const st=await getSettings(env);const pricing=requirePmPrintingPricing(await getPricing(env));const ink=pmInkSettings(st);return {success:true,accountManagement:await accountManagementOn(env),totalCustomers:num((await env.DB.prepare('SELECT COUNT(*) c FROM pm_customers').first())?.c),printingAvailable:st.printing_available!=='false',pickupLocation:st.pickup_location||'',serviceMessage:st.service_message||'',pricing,pmInkPricing:{blackInkRate:centsToNumber(ink.blackInkRateCents).toFixed(2),colorInkRate:centsToNumber(ink.colorInkRateCents).toFixed(2),minimumInkCharge:centsToNumber(ink.minInkChargeCents).toFixed(2),coverageThreshold:String(ink.coverageThresholdPercent),rounding:'NEAREST_WHOLE_PESO_HALF_UP'},locations:await getLocations(env,false),vouchers:(await listVouchers(env)),orders:await adminOrders(env,'',origin,100,apiPrefix)};}
  if(action==='getAdminOrders')return {success:true,orders:await adminOrders(env,clean(data.status),origin,data.limit,apiPrefix)};
  if(action==='updateOrderStatus')return await updateOrder(env,[clean(data.orderId)],clean(data.status),data.reason||'',user);
  if(action==='updateOrdersStatusBulk')return await updateOrder(env,(data.orderIds||[]).map(clean).filter(Boolean),clean(data.status),data.reason||'',user);
  if(action==='setPrintingAvailability'){await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('printing_available',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(data.available?'true':'false',now()).run();return {success:true,printingAvailable:!!data.available};}
  if(action==='setPickupLocation'){const v=clean(data.location);if(!v)throw new Error('Pickup location cannot be empty.');await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('pickup_location',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(v,now()).run();return {success:true,pickupLocation:v};}
  if(action==='getPricing')return {success:true,pricing:await getPricing(env)};
  if(action==='savePricing'){const allowed=['text_bw','text_color','text_image_bw','text_image_color','image_bw','image_color','paper_per_sheet'];for(const k of allowed){if(data[k]!==undefined){const v=num(data[k],-1);if(v<0)throw new Error('Prices cannot be negative.');await env.DB.prepare('INSERT INTO pricing(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(k,v,now()).run();}}await log(env,user.username,'UPDATE_PRICING','Printing prices updated.');return {success:true,pricing:await getPricing(env)};}
  if(action==='getPmInkPricing'){const st=await getSettings(env);const ink=pmInkSettings(st);return {success:true,pricing:{blackInkRate:centsToNumber(ink.blackInkRateCents).toFixed(2),colorInkRate:centsToNumber(ink.colorInkRateCents).toFixed(2),minimumInkCharge:centsToNumber(ink.minInkChargeCents).toFixed(2),coverageThreshold:String(ink.coverageThresholdPercent),rounding:'NEAREST_WHOLE_PESO_HALF_UP'}};}
  if(action==='savePmInkPricing'){
    const values={pmprint_black_ink_rate:clean(data.blackInkRate),pmprint_color_ink_rate:clean(data.colorInkRate),pmprint_min_ink_charge:clean(data.minimumInkCharge),pmprint_coverage_threshold:clean(data.coverageThreshold)};
    for(const [k,v] of Object.entries(values)){if(!v)throw new Error('All PMPRINT ink pricing values are required.'); if(k==='pmprint_coverage_threshold'){const n=Number(v);if(!Number.isFinite(n)||n<0||n>100)throw new Error('Coverage threshold must be between 0 and 100%.');}else decimalToCents(v);}
    const t=now();for(const [k,v] of Object.entries(values))await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(k,v,t).run();
    await log(env,user.username,'UPDATE_PMPRINT_INK_PRICING','PMPRINT ink pricing updated.');return {success:true,pricing:{blackInkRate:values.pmprint_black_ink_rate,colorInkRate:values.pmprint_color_ink_rate,minimumInkCharge:values.pmprint_min_ink_charge,coverageThreshold:values.pmprint_coverage_threshold,rounding:'NEAREST_WHOLE_PESO_HALF_UP'}};
  }
  if(action==='saveInkOverride'){
    const oid=clean(data.orderId);const value=clean(data.override);if(!value)throw new Error('Enter an ink override amount.');const overrideNumber=Number(value);if(!Number.isFinite(overrideNumber)||overrideNumber<0)throw new Error('Invalid ink override amount.');const finalInk=roundWholePeso(overrideNumber);const row=await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first();if(!row)throw new Error('Order not found.');
    const snap=safeJson(row.pricing_snapshot_json,{});
    const oldRawInk=num(snap.raw_additional_ink_cost,row.automatic_ink_cost);
    const oldFinalInk=num(snap.final_additional_ink_cost,row.final_ink_cost);
    const oldSubtotal=num(row.subtotal,snap.subtotal);
    const voucherDiscount=num(row.discount,snap.voucher_discount);
    const baseAfterVoucher=Math.max(0,oldSubtotal-oldFinalInk);
    const adjustment=wholePesoAdjustment(baseAfterVoucher+finalInk);
    const newSnap={...snap,raw_additional_ink_cost:oldRawInk,final_additional_ink_cost:finalInk,subtotal:adjustment.subtotal,centavo_discount:adjustment.discount,voucher_discount:voucherDiscount,final_total:adjustment.finalTotal,pricing_source:'ADMIN_OVERRIDE',rounding_rule:'CENTAVO_DISCOUNT_BELOW_0.50_ELSE_ROUND_UP',snapshot_timestamp:snap.snapshot_timestamp||now()};
    await env.DB.prepare("UPDATE orders SET admin_ink_override=?,final_ink_cost=?,subtotal=?,centavo_discount=?,final_total=?,amount=?,pricing_snapshot_json=?,updated_at=? WHERE id=?").bind(finalInk,finalInk,adjustment.subtotal,adjustment.discount,adjustment.finalTotal,adjustment.finalTotal,JSON.stringify(newSnap),now(),oid).run();
    const fresh=await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first();return {success:true,order:rowOrder(fresh,origin,apiPrefix)};
  }
  if(action==='getLocations'){
    const locations=await getLocations(env,false);
    return {success:true,locations,_diagnostic:{source:env.PM_DB?'PM_DB':(env.DB?'DB':'NO_DATABASE_BINDING'),table:'locations',httpStatus:200}};
  }
  if(action==='saveLocation'){const name=clean(data.name);if(!name)throw new Error('Location name is required.');const fee=num(data.fee,-1);if(fee<0)throw new Error('Location fee cannot be negative.');const lid=clean(data.id)||id('LOC');await env.DB.prepare('INSERT INTO locations(id,name,fee,active,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,fee=excluded.fee,active=excluded.active,updated_at=excluded.updated_at').bind(lid,name,fee,data.active===false?0:1,now(),now()).run();return {success:true,locations:await getLocations(env,false)};}
  if(action==='deleteLocation'){await env.DB.prepare('DELETE FROM locations WHERE id=?').bind(clean(data.id)).run();return {success:true,locations:await getLocations(env,false)};}
  if(action==='createVoucher'){const code=clean(data.code).toUpperCase();if(!/^[A-Z0-9_-]{3,20}$/.test(code))throw new Error('Voucher code must be 3–20 letters/numbers.');const type=clean(data.type||'percent');if(!['percent','fixed','free_shipping'].includes(type))throw new Error('Invalid voucher type.');const value=num(data.value);if(type!=='free_shipping'&&value<=0)throw new Error('Discount value must be greater than zero.');if(type==='percent'&&value>100)throw new Error('Percentage discount cannot exceed 100%.');await env.DB.prepare(`INSERT INTO vouchers(code,type,value,min_spend,max_discount,max_shipping_discount,min_pages,min_copies,total_usage_limit,per_device_limit,start_at,end_at,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET type=excluded.type,value=excluded.value,min_spend=excluded.min_spend,max_discount=excluded.max_discount,max_shipping_discount=excluded.max_shipping_discount,min_pages=excluded.min_pages,min_copies=excluded.min_copies,total_usage_limit=excluded.total_usage_limit,per_device_limit=excluded.per_device_limit,start_at=excluded.start_at,end_at=excluded.end_at,active=excluded.active,updated_at=excluded.updated_at`).bind(code,type,value,num(data.minSpend),data.maxDiscount===''||data.maxDiscount==null?null:num(data.maxDiscount),data.maxShippingDiscount===''||data.maxShippingDiscount==null?null:num(data.maxShippingDiscount),Math.max(0,Math.floor(num(data.minPages))),Math.max(0,Math.floor(num(data.minCopies))),data.totalUsageLimit===''||data.totalUsageLimit==null?null:Math.max(0,Math.floor(num(data.totalUsageLimit))),Math.max(1,Math.floor(num(data.perDeviceLimit,1))),data.startAt||null,data.endAt||null,1,now(),now()).run();return {success:true,vouchers:await listVouchers(env)};}
  if(action==='listVouchers')return {success:true,vouchers:await listVouchers(env)};
  if(action==='setVoucherActive'){await env.DB.prepare('UPDATE vouchers SET active=?,updated_at=? WHERE code=?').bind(data.active?1:0,now(),clean(data.code).toUpperCase()).run();return {success:true,vouchers:await listVouchers(env)};}
  if(action==='deleteVoucher'){
    const code=clean(data.code).toUpperCase();
    if(!code)throw new Error('Voucher code is required.');
    const existing=await env.DB.prepare('SELECT code FROM vouchers WHERE code=?').bind(code).first();
    if(!existing)throw new Error('Voucher not found.');
    const t=now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM pm_customer_vouchers WHERE voucher_code=?').bind(code),
      env.DB.prepare('DELETE FROM voucher_redemptions WHERE voucher_code=?').bind(code),
      env.DB.prepare('DELETE FROM vouchers WHERE code=?').bind(code)
    ]);
    await log(env,user.username,'DELETE_VOUCHER',`Deleted voucher ${code} at ${t}.`);
    return {success:true,vouchers:await listVouchers(env)};
  }
  if(action==='resetPrintingData'){if(clean(data.confirm)!=='RESET')throw new Error('Type RESET to confirm.');let deleted=0;const prefixes=env.PM_PRINT?['pmprinting/','pmprint/orders/']:['printing/'];for(const prefix of prefixes){let cursor;do{const listed=await env.PRINT_FILES.list({prefix,cursor});for(const o of listed.objects||[]){try{await env.PRINT_FILES.delete(o.key);deleted++;}catch(_){}}cursor=listed.truncated?listed.cursor:undefined;}while(cursor);}const stmts=[env.DB.prepare('DELETE FROM voucher_redemptions'),env.DB.prepare('DELETE FROM notifications'),env.DB.prepare('DELETE FROM orders')];await env.DB.batch(stmts);await log(env,user.username,'RESET_PRINTING_DATA',`Reset printing data; deleted ${deleted} R2 file(s).`);return {success:true,deleted};}
  throw new Error('Unknown admin action.');
}
async function listVouchers(env){const {results}=await env.DB.prepare('SELECT * FROM vouchers ORDER BY created_at DESC').all();return results.map(v=>({code:v.code,type:v.type,value:num(v.value),minSpend:num(v.min_spend),maxDiscount:v.max_discount===null?null:num(v.max_discount),maxShippingDiscount:v.max_shipping_discount===null?null:num(v.max_shipping_discount),minPages:num(v.min_pages),minCopies:num(v.min_copies),totalUsageLimit:v.total_usage_limit===null?null:num(v.total_usage_limit),perDeviceLimit:num(v.per_device_limit,1),startAt:v.start_at,endAt:v.end_at,active:!!v.active,label:v.type==='percent'?`${num(v.value)}% OFF`:v.type==='fixed'?`₱${num(v.value).toFixed(2)} OFF`:'FREE DELIVERY'}));}


async function cartConfigSummary(env,settings,config){
  const pages=Math.floor(num(config.pages));
  const copies=Math.floor(num(config.copies,1));
  const content=clean(config.contentType),color=clean(config.color),sides=clean(config.sides),format=clean(config.format),paper=clean(config.paperSize),binding=clean(config.binding);
  if(pages<1||copies<1)throw new Error('Cart item has invalid page or copy data.');
  if(!['Text Only','Text + Image','Image Only'].includes(content)||!['Black & White','Colored'].includes(color)||!['Single-sided','Double-sided','Back-to-back'].includes(sides)||!['Regular','Booklet','Tarpapel'].includes(format)||!paper)throw new Error('Cart item has invalid printing options.');
  const pricing=await getPricing(env);requirePmPrintingPricing(pricing);const calc=calculatePrice(pricing,pages,copies,content,color,sides,format);
  const inkSettings=pmInkSettings(settings);const analysis=normalizeInkAnalysis(config.inkAnalysis,pages);const selection=parsePageSelectionServer(clean(config.pageSelection),pages);const ink=calculatePmInk(inkSettings,analysis,selection.pages.length?selection.pages:analysis.map(p=>p.page_number),color);
  const inkCost=ink.totalInkCost*copies;const base=calc.baseTotal;return {pages,copies,content,color,sides:format==='Booklet'?'Double-sided':sides,format,paperSize:paper,binding,baseTotal:base,printingCost:calc.printingCost,paperCost:calc.paperCost,inkCost,subtotal:base+inkCost,fileName:clean(config.fileName),fileHash:clean(config.fileHash),fileType:clean(config.fileType),pageSelection:clean(config.pageSelection),inkAnalysis:analysis};
}
async function getCartItems(env,customerId){
  const {results}=await env.DB.prepare('SELECT id,file_name,file_hash,file_type,file_size,config_json,created_at,updated_at FROM pm_cart_items WHERE customer_id=? ORDER BY created_at DESC').bind(customerId).all();
  const settings=await getSettings(env);const items=[];
  for(const row of results||[]){const config=safeJson(row.config_json,{});try{const summary=await cartConfigSummary(env,settings,config);items.push({id:row.id,fileName:row.file_name||summary.fileName,fileHash:row.file_hash||summary.fileHash,fileType:row.file_type||summary.fileType,fileSize:num(row.file_size),createdAt:row.created_at,updatedAt:row.updated_at,config,summary});}catch(e){items.push({id:row.id,fileName:row.file_name||'Cart item',fileHash:row.file_hash||'',fileType:row.file_type||'',fileSize:num(row.file_size),createdAt:row.created_at,updatedAt:row.updated_at,config,summary:null,error:e.message||'Invalid cart item'});}}
  return items;
}

async function handle(request, env){
  const incomingUrl = new URL(request.url);
  const isPmPrint = incomingUrl.pathname === '/' || incomingUrl.pathname === '/pmprint' || incomingUrl.pathname === '/pmadmin' || incomingUrl.pathname === '/admin.html' || incomingUrl.pathname === '/pmprint.html' || incomingUrl.pathname === '/api/pmprint' || incomingUrl.pathname.startsWith('/api/pmprint/');
  if(!isPmPrint) return new Response('Not Found',{status:404});
  if(incomingUrl.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/pmprint.html',request.url),request));
  if(incomingUrl.pathname === '/pmadmin') return env.ASSETS.fetch(new Request(new URL('/admin.html',request.url),request));
  if(incomingUrl.pathname === '/admin.html') return env.ASSETS.fetch(request);
  if(incomingUrl.pathname === '/pmprint') return env.ASSETS.fetch(new Request(new URL('/pmprint.html',request.url),request));
  if(incomingUrl.pathname === '/pmprint.html') return env.ASSETS.fetch(request);
  // PM PRINT is isolated from the normal BSAIS database. Prefer the dedicated PM_DB binding.
  // Keep DB as a compatibility fallback for older standalone deployments.
  const pmDatabase=env.PM_DB||env.DB;
  if(!pmDatabase) return err('PM PRINT database binding is not configured. Expected PM_DB.',503);
  if(!env.PRINT_FILES) return err('PM PRINT R2 storage binding is not configured.',503);
  env={...env,DB:pmDatabase,PM_DB:pmDatabase,API_PREFIX:'/api/pmprint',ADMIN_COOKIE:'pmprint_admin',PRINT_PREFIX:'pmprinting/',PM_PRINT:true};
  try{await ensurePmSchema(env);}catch(e){return err(e.message||'PM PRINT database schema is unavailable.',503);}
  const url=new URL(request.url),origin=url.origin,apiPrefix='/api/pmprint';

  if(url.pathname.startsWith(apiPrefix+'/admin/file')){
    try{
      await requireAdmin(env,request);
      const oid=url.searchParams.get('orderId');
      const r=await env.DB.prepare('SELECT r2_key,file_name FROM orders WHERE id=?').bind(oid).first();
      if(!r?.r2_key)return err('File not found.',404);
      if(!String(r.r2_key).startsWith('pmprint/orders/'))return err('Invalid PM PRINT file.',400);
      const obj=await env.PRINT_FILES.get(r.r2_key);if(!obj)return err('File not found in R2.',404);
      const h=new Headers();obj.writeHttpMetadata(h);h.set('content-disposition',`inline; filename="${String(r.file_name||'document').replace(/["\r\n]/g,'')}"`);h.set('cache-control','private, max-age=60');
      return new Response(obj.body,{headers:h});
    }catch(e){return err(e.message||String(e),401);}
  }
  if(!url.pathname.startsWith(apiPrefix+'/'))return err('Unknown PM PRINT route.',404);

  try{
    const action=url.pathname.slice(apiPrefix.length).split('/').filter(Boolean)[0]||'';
    let data={};
    if(request.method!=='GET'){
      const ct=request.headers.get('content-type')||'';
      if((action==='createOrder'||action==='addCartItem')&&ct.toLowerCase().includes('multipart/form-data')){
        const form=await request.formData();const raw=form.get(action==='addCartItem'?'config_json':'orderData');if(typeof raw!=='string')throw new Error(action==='addCartItem'?'Cart configuration is missing.':'Order data is missing.');
        try{data=JSON.parse(raw);}catch(_){if(action==='addCartItem')data={config_json:raw};else throw new Error('Invalid order data.');}
        if(action==='addCartItem'){data.config_json=raw;}
        const file=form.get('file');if(!(file instanceof File))throw new Error('Please select a file first.');data.uploadedFile=file;
      }else{try{data=await request.json();}catch(_){data={};}}
    }else url.searchParams.forEach((v,k)=>data[k]=v);

    if(action==='getAccountState'){const settings=await getSettings(env);const raw=clean(settings.pmprint_account_management).toLowerCase();const on=raw==='1'||raw==='true'||raw==='on';let customer=null;try{customer=publicCustomer(await requireCustomer(env,request));}catch(_){}return json({success:true,accountManagement:on,accountManagementValue:on?'1':'0',customer});}
    if(action==='customerLogin'){if(!(await accountManagementOn(env)))return json({success:false,error:'Account Management is currently turned off.'},400);const username=clean(data.username).toLowerCase();const password=String(data.password||'');if(!username||!password)throw new Error('Username and password are required.');const c=await env.DB.prepare('SELECT * FROM pm_customers WHERE username=?').bind(username).first();if(!c){await accountActivity(env,{username},'LOGIN_FAILED','Invalid username or password.',request);return json({success:false,error:'Invalid username or password.'},401);}const salt=c.password_salt;const hash=await accountPasswordHash(password,salt);if(hash!==c.password_hash||c.status!=='Active'){await accountActivity(env,c,'LOGIN_FAILED',c.status!=='Active'?'Inactive account login attempt.':'Invalid password.',request);return json({success:false,error:c.status!=='Active'?'This account is inactive.':'Invalid username or password.'},401);}return customerSessionResponse(env,request,c,!!data.remember);}
    if(action==='customerLogout'){const token=getCookie(request,'pmprint_customer');if(token){const h=await sha256(token);const c=await env.DB.prepare('SELECT c.* FROM pm_customer_sessions s INNER JOIN pm_customers c ON c.id=s.customer_id WHERE s.token_hash=?').bind(h).first();if(c)await accountActivity(env,c,'LOGOUT','Customer signed out.',request);await env.DB.prepare('DELETE FROM pm_customer_sessions WHERE token_hash=?').bind(h).run();}return json({success:true},200,{'set-cookie':cookie('pmprint_customer','',{maxAge:0})});}
    if(action==='getCustomerProfile'){return json({success:true,customer:publicCustomer(await requireCustomer(env,request))});}
    if(action==='changeCustomerPassword'){const c=await requireCustomer(env,request);const old=String(data.currentPassword||''),nw=String(data.newPassword||'');if(nw.length<8)throw new Error('New password must be at least 8 characters.');if(await accountPasswordHash(old,c.password_salt)!==c.password_hash)throw new Error('Current password is incorrect.');const salt=crypto.randomUUID()+crypto.randomUUID(),hash=await accountPasswordHash(nw,salt);await env.DB.prepare('UPDATE pm_customers SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').bind(hash,salt,now(),c.id).run();await accountActivity(env,c,'PASSWORD_CHANGED','Customer password changed.',request);return json({success:true});}
    if(action==='addCartItem'){
      if(!await accountManagementOn(env))throw new Error('Cart is available only when Account Management is turned on.');
      const c=await requireCustomer(env,request);const file=data.uploadedFile;if(!(file instanceof File))throw new Error('Please select a file first.');
      if(file.size>MAX_UPLOAD_BYTES)throw new Error('File is larger than 20 MB. Please choose a file up to 20 MB.');
      const config=safeJson(clean(data.config_json),{});if(!config||!Array.isArray(config.inkAnalysis))throw new Error('Printing analysis is missing. Please analyze the file again.');
      const settings=await getSettings(env);const summary=await cartConfigSummary(env,settings,config);const hash=await sha256Bytes(await file.arrayBuffer());if(clean(config.fileHash)&&hash!==clean(config.fileHash))throw new Error('The selected file changed after analysis. Please select it again.');
      const itemId=id('CART');const safe=String(file.name||config.fileName||'document').replace(/[^A-Za-z0-9._-]/g,'_');const key=`pmprint/cart/${c.id}/${itemId}/${safe}`;
      const bytes=await file.arrayBuffer();await env.PRINT_FILES.put(key,bytes,{httpMetadata:{contentType:clean(file.type)||clean(config.fileType)||'application/octet-stream'},customMetadata:{customerId:c.id,fileHash:hash}});
      try{await env.DB.prepare('INSERT INTO pm_cart_items(id,customer_id,file_name,r2_key,file_hash,file_type,file_size,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(itemId,c.id,safe,key,hash,clean(file.type)||clean(config.fileType),file.size,JSON.stringify({...config,fileHash:hash,fileName:safe,fileType:clean(file.type)||clean(config.fileType)}),now(),now()).run();}catch(e){try{await env.PRINT_FILES.delete(key)}catch(_){}throw e;}
      return json({success:true,item:{id:itemId,fileName:safe,fileSize:file.size,summary}});
    }
    if(action==='getCart'){
      const c=await requireCustomer(env);const items=await getCartItems(env,c.id);return json({success:true,items});
    }
    if(action==='deleteCartItem'){
      const c=await requireCustomer(env);const itemId=clean(data.itemId);const row=await env.DB.prepare('SELECT id,r2_key FROM pm_cart_items WHERE id=? AND customer_id=?').bind(itemId,c.id).first();if(!row)throw new Error('Cart item not found.');await env.DB.prepare('DELETE FROM pm_cart_items WHERE id=? AND customer_id=?').bind(itemId,c.id).run();if(row.r2_key){try{await env.PRINT_FILES.delete(row.r2_key)}catch(_){}}return json({success:true,deleted:itemId});
    }
    if(action==='checkoutCart'){
      if(!(await accountManagementOn(env)))throw new Error('Cart checkout is available only when Account Management is turned on.');
      const c=await requireCustomer(env);const ids=[...new Set((Array.isArray(data.itemIds)?data.itemIds:[]).map(x=>clean(x)).filter(Boolean))];if(!ids.length)throw new Error('Select at least one cart item.');
      const all=await getCartItems(env,c.id);const selected=all.filter(x=>ids.includes(x.id));if(selected.length!==ids.length)throw new Error('One or more selected cart items are no longer available.');if(selected.some(x=>!x.summary))throw new Error('One or more cart items need to be added again.');
      const fulfillment=clean(data.fulfillment||'Pickup');if(!['Pickup','Delivery'].includes(fulfillment))throw new Error('Invalid order method.');let locationId=clean(data.locationId),location='';let deliveryFee=0;
      if(fulfillment==='Delivery'){const loc=locationId?await env.DB.prepare('SELECT * FROM locations WHERE id=? AND active=1').bind(locationId).first():null;if(!loc)throw new Error('Selected delivery location is no longer available.');location=loc.name;deliveryFee=num(loc.fee);}
      else{location=clean((await getSettings(env)).pickup_location)||'Yao St., Purok 5, Naganacan, Cauayan City, Isabela';}
      const aggregateSubtotal=selected.reduce((a,x)=>a+Number(x.summary.subtotal||0),0);const aggregatePages=selected.reduce((a,x)=>a+Number(x.summary.pages||0),0);const aggregateCopies=selected.reduce((a,x)=>a+Number(x.summary.copies||0),0);const deviceId=clean(data.deviceId);
      const codes=[...new Set((Array.isArray(data.voucherCodes)?data.voucherCodes:String(data.voucherCode||'').split(',')).map(x=>clean(x).toUpperCase()).filter(Boolean))];
      const vr=await validateVouchersServer(env,{codes,subtotal:aggregateSubtotal,pages:aggregatePages,copies:aggregateCopies,deliveryFee,deviceId,customerId:c.id,accountManaged:true});
      const checkoutId=id('CHK');const createdOrders=[];let remainingPrint=Number(vr.printDiscount||0),remainingShipping=Number(vr.shippingDiscount||0);const info=vr.vouchers||[];
      for(let i=0;i<selected.length;i++){
        const item=selected[i],s=item.summary,itemDelivery=(i===0?deliveryFee:0);const ratio=aggregateSubtotal>0?Number(s.subtotal||0)/aggregateSubtotal:0;let itemPrint=i===selected.length-1?remainingPrint:Number((vr.printDiscount*ratio).toFixed(2));itemPrint=Math.min(itemPrint,Number(s.subtotal||0));remainingPrint=Math.max(0,Number((remainingPrint-itemPrint).toFixed(2)));let itemShipping=i===0?Math.min(remainingShipping,itemDelivery):0;remainingShipping=Math.max(0,Number((remainingShipping-itemShipping).toFixed(2)));const itemDiscount=Math.min(Number(s.subtotal||0)+itemDelivery,Number((itemPrint+itemShipping).toFixed(2)));
        const cfg=item.config;const orderData={...cfg,studentName:c.name,contact:c.phone,fileName:item.fileName,fileHash:item.fileHash,fileType:item.fileType,r2Key:cfg.r2Key||'',fulfillment,location,locationId,notes:clean(data.notes),deviceId,customerId:c.id,voucherCodes:[],voucherCode:'',discount:0,_voucherValidated:true,_voucherDiscount:itemDiscount,_voucherCodes:vr.codes,_voucherInfo:info,checkoutId};orderData.r2Key=(await env.DB.prepare('SELECT r2_key FROM pm_cart_items WHERE id=? AND customer_id=?').bind(item.id,c.id).first())?.r2_key||'';if(!orderData.r2Key)throw new Error('Cart file is missing.');
        try{const out=await createOrder(env,orderData,origin,apiPrefix,request,{internal:true});createdOrders.push(out.order);await env.DB.prepare('UPDATE orders SET checkout_id=? WHERE id=?').bind(checkoutId,out.order.OrderID).run();}catch(e){throw new Error('Checkout failed while creating '+item.fileName+': '+(e.message||'Unknown error'));}
      }
      if(vr.codes.length&&createdOrders.length){const first=createdOrders[0].OrderID;for(const v of vr.vouchers){await env.DB.prepare('INSERT INTO voucher_redemptions(id,voucher_code,device_id,order_id,discount,created_at) VALUES(?,?,?,?,?,?)').bind(id('VR'),v.code,deviceId,first,v.discount,now()).run();}}
      return json({success:true,checkoutId,orders:createdOrders,subtotal:aggregateSubtotal,deliveryFee,discount:vr.discount,printDiscount:vr.printDiscount,shippingDiscount:vr.shippingDiscount,total:Math.max(0,aggregateSubtotal+deliveryFee-vr.discount),codes:vr.codes});
    }
    if(action==='getCustomerOrders'){const c=await requireCustomer(env,request);const {results}=await env.DB.prepare('SELECT id,file_name,status,status_reason,payment_status,fulfillment,delivery_fee,discount,subtotal,centavo_discount,final_total,amount,created_at,updated_at FROM orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 100').bind(c.id).all();return json({success:true,orders:results.map(o=>({id:o.id,fileName:o.file_name||'',status:o.status||'Pending',statusReason:o.status_reason||'',paymentStatus:o.payment_status||'Payment Due',fulfillment:o.fulfillment||'',deliveryFee:num(o.delivery_fee),discount:num(o.discount),subtotal:num(o.subtotal),centavoDiscount:num(o.centavo_discount),finalTotal:num(o.final_total,o.amount),amount:num(o.amount),createdAt:o.created_at||'',updatedAt:o.updated_at||''}))});}
    // Customer My Orders API: these are dedicated server actions and always verify ownership server-side.
    if(action==='customerCheckOrderStatus'||action==='getCustomerOrderStatus'||action==='checkCustomerOrderStatus'){
      const c=await requireCustomer(env,request);const oid=clean(data.orderId).toUpperCase();if(!oid)throw new Error('Order ID is required.');
      const o=await env.DB.prepare('SELECT id,file_name,status,status_reason,payment_status,fulfillment,location,ready_pickup_location,delivery_fee,discount,subtotal,centavo_discount,final_total,amount,printing_cost,paper_cost,automatic_ink_cost,final_ink_cost,ink_analysis_json,pricing_snapshot_json,created_at,updated_at,customer_name,contact,voucher_code FROM orders WHERE id=? AND customer_id=?').bind(oid,c.id).first();
      if(!o)throw new Error('Order was not found in your account.');
      return json({success:true,order:{id:o.id,fileName:o.file_name||'',status:o.status||'Pending',statusReason:o.status_reason||'',paymentStatus:o.payment_status||'Payment Due',fulfillment:o.fulfillment||'',location:o.location||'',readyPickupLocation:o.ready_pickup_location||'',deliveryFee:num(o.delivery_fee),discount:num(o.discount),subtotal:num(o.subtotal),centavoDiscount:num(o.centavo_discount),finalTotal:num(o.final_total,o.amount),amount:num(o.amount),printingCost:num(o.printing_cost),paperCost:num(o.paper_cost),automaticInkCost:num(o.automatic_ink_cost),additionalInkUsage:num(o.final_ink_cost,o.automatic_ink_cost),inkAnalysis:safeJson(o.ink_analysis_json,{}),pricingSnapshot:safeJson(o.pricing_snapshot_json,{}),voucherCode:o.voucher_code||'',studentName:o.customer_name||c.name||'',contact:o.contact||c.phone||'',createdAt:o.created_at||'',updatedAt:o.updated_at||''}});
    }
    if(action==='customerCancelOrder'||action==='cancelCustomerOrder'){const c=await requireCustomer(env,request);const oid=clean(data.orderId).toUpperCase();if(!oid)throw new Error('Order ID is required.');const o=await env.DB.prepare('SELECT id,status,r2_key FROM orders WHERE id=? AND customer_id=?').bind(oid,c.id).first();if(!o)throw new Error('Order was not found in your account.');if(String(o.status||'Pending').toLowerCase()!=='pending')throw new Error('Only Pending orders can be cancelled.');
      // A cancelled order is removed completely from the customer's purchase history.
      // Notifications are removed first so no orphan notification can remain.
      await env.DB.prepare('DELETE FROM notifications WHERE order_id=?').bind(oid).run();
      await env.DB.prepare('DELETE FROM voucher_redemptions WHERE order_id=?').bind(oid).run();
      await env.DB.prepare("DELETE FROM orders WHERE id=? AND customer_id=? AND status='Pending'").bind(oid,c.id).run();
      if(o.r2_key){try{await env.PRINT_FILES.delete(o.r2_key)}catch(_){} }
      await accountActivity(env,c,'ORDER_CANCELLED','Customer cancelled and deleted order '+oid+'.',request);
      return json({success:true,orderId:oid,status:'Deleted',deleted:true});}
    if(action==='getCustomerVouchers'){
      const c=await requireCustomer(env,request);
      const {results}=await env.DB.prepare('SELECT v.code,v.type,v.value,v.min_spend,v.max_discount,v.max_shipping_discount,v.start_at,v.end_at FROM pm_customer_vouchers cv INNER JOIN vouchers v ON v.code=cv.voucher_code WHERE cv.customer_id=? AND v.active=1').bind(c.id).all();
      const t=Date.now();
      const vouchers=results.filter(v=>{
        const start=v.start_at?new Date(v.start_at).getTime():NaN;
        const end=v.end_at?new Date(v.end_at).getTime():NaN;
        return (!v.start_at||Number.isNaN(start)||start<=t)&&(!v.end_at||Number.isNaN(end)||end>=t);
      }).map(v=>({code:v.code,type:v.type,label:v.type==='percent'?`${num(v.value)}% OFF`:v.type==='fixed'?`₱${num(v.value).toFixed(2)} OFF`:'FREE DELIVERY',minSpend:num(v.min_spend),maxDiscount:v.max_discount==null?null:num(v.max_discount),maxShippingDiscount:v.max_shipping_discount==null?null:num(v.max_shipping_discount),startAt:v.start_at||null,endAt:v.end_at||null}));
      return json({success:true,vouchers});
    }


    if(action==='getCustomerVoucherLinks'){
      await requireAdmin(env,request);
      const cid=clean(data.customerId);if(!cid)throw new Error('Customer account is required.');
      const customer=await env.DB.prepare('SELECT id,username,name FROM pm_customers WHERE id=?').bind(cid).first();if(!customer)throw new Error('Customer account not found.');
      const {results}=await env.DB.prepare(`SELECT v.code,v.type,v.value,v.min_spend,v.max_discount,v.max_shipping_discount,v.start_at,v.end_at,v.active,CASE WHEN cv.customer_id IS NULL THEN 0 ELSE 1 END linked FROM vouchers v LEFT JOIN pm_customer_vouchers cv ON cv.voucher_code=v.code AND cv.customer_id=? WHERE v.active=1 ORDER BY v.created_at DESC`).bind(cid).all();
      return json({success:true,customer:{id:customer.id,username:customer.username,name:customer.name},vouchers:results.map(v=>({code:v.code,type:v.type,value:num(v.value),label:v.type==='percent'?`${num(v.value)}% OFF`:v.type==='fixed'?`₱${num(v.value).toFixed(2)} OFF`:'FREE DELIVERY',minSpend:num(v.min_spend),maxDiscount:v.max_discount===null?null:num(v.max_discount),maxShippingDiscount:v.max_shipping_discount===null?null:num(v.max_shipping_discount),startAt:v.start_at,endAt:v.end_at,active:!!v.active,linked:!!v.linked}))});
    }
    if(action==='setCustomerVoucherLinks'){
      const admin=await requireAdmin(env,request);
      const cid=clean(data.customerId);if(!cid)throw new Error('Customer account is required.');
      const customer=await env.DB.prepare('SELECT id,username,name FROM pm_customers WHERE id=?').bind(cid).first();if(!customer)throw new Error('Customer account not found.');
      const codes=[...new Set((Array.isArray(data.voucherCodes)?data.voucherCodes:[]).map(x=>clean(x).toUpperCase()).filter(Boolean))];
      const valid=[];for(const code of codes){const v=await env.DB.prepare('SELECT code,type,value FROM vouchers WHERE code=?').bind(code).first();if(v)valid.push(code);}
      const oldLinks=await env.DB.prepare('SELECT voucher_code FROM pm_customer_vouchers WHERE customer_id=?').bind(cid).all();
      const oldSet=new Set((oldLinks.results||[]).map(x=>String(x.voucher_code||'').toUpperCase()));
      await env.DB.prepare('DELETE FROM pm_customer_vouchers WHERE customer_id=?').bind(cid).run();
      for(const code of valid)await env.DB.prepare('INSERT INTO pm_customer_vouchers(customer_id,voucher_code,assigned_at,created_at,updated_at) VALUES(?,?,?,?,?)').bind(cid,code,now(),now(),now()).run();
      for(const code of valid.filter(x=>!oldSet.has(x))) await createCustomerNotification(env,cid,{type:'voucher',category:'voucher',title:'New voucher available',message:`Voucher ${code} has been added to your PM PRINT account.`});
      await accountActivity(env,customer,'VOUCHERS_UPDATED',`Administrator linked ${valid.length} voucher(s) to this account.`,request);await log(env,admin.username,'CUSTOMER_VOUCHERS_UPDATED',`Updated vouchers for customer ${customer.username}.`);
      return json({success:true,customerId:cid,linked:valid});
    }
    if(action==='adminSession'){const session=await requireAdmin(env,request);return json({success:true,authenticated:true,username:session.username||''});}
    if(action==='adminLogin'){
      const username=clean(data.username);
      const password=String(data.password||'');
      const configuredUsername=clean(env.PM_ADMIN_USERNAME||'');
      const configuredPassword=String(env.PM_ADMIN_PASSWORD||'');
      if(!configuredUsername||!configuredPassword)return err('PM PRINT administrator credentials are not configured in Cloudflare Worker Secrets.',503);
      if(username!==configuredUsername||password!==configuredPassword)return json({success:false,error:'Invalid username or password.'},401);
      const token=crypto.randomUUID()+crypto.randomUUID(),th=await sha256(token),exp='9999-12-31T23:59:59.999Z';
      await env.DB.prepare('INSERT INTO sessions(token_hash,username,name,role,permissions,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(th,username,'Administrator','Administrator','ALL',now(),exp).run();
      return json({success:true},200,{'set-cookie':cookie(env.ADMIN_COOKIE,token,{maxAge:2147483647})});
    }
    if(action==='adminLogout'){
      const token=getCookie(request,env.ADMIN_COOKIE);if(token)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();
      return json({success:true},200,{'set-cookie':cookie(env.ADMIN_COOKIE,'',{maxAge:0})});
    }
    if(action==='status'){
      const s=await getSettings(env);return json({success:true,printingAvailable:s.printing_available!=='false',pickupLocation:s.pickup_location||'',serviceMessage:s.service_message||''});
    }
    if(action==='getOrder'){
      const r=await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(clean(data.orderId).toUpperCase()).first();if(!r)throw new Error('Order ID was not found.');
      return json({success:true,order:rowOrder(r,origin,apiPrefix)});
    }
    if(action==='getLocations'){const locations=await getLocations(env,true);return json({success:true,locations,_diagnostic:{source:env.PM_DB?'PM_DB':(env.DB?'DB':'NO_DATABASE_BINDING'),table:'locations',httpStatus:200}});}
    if(action==='getPricing')return json({success:true,pricing:await getPricing(env)});
    if(action==='validateVouchers'){const p=await getPricing(env),pages=Math.max(1,Math.floor(num(data.pages,1))),copies=Math.max(1,Math.floor(num(data.copies,1)));let subtotal=num(data.amount);if(!subtotal&&data.contentType)subtotal=calculatePrice(p,pages,copies,clean(data.contentType),clean(data.color),clean(data.sides),clean(data.format)).baseTotal;const managed=await accountManagementOn(env);const c=managed?await requireCustomer(env,request):null;const v=await validateVouchersServer(env,{codes:data.codes,subtotal,pages,copies,deliveryFee:num(data.deliveryFee),deviceId:clean(data.deviceId),customerId:c?.id||null,accountManaged:managed});return json({success:true,...v});}
    if(action==='validateVoucher'){
      const p=await getPricing(env),pages=Math.max(1,Math.floor(num(data.pages,1))),copies=Math.max(1,Math.floor(num(data.copies,1)));
      let subtotal=num(data.amount);if(!subtotal&&data.contentType)subtotal=calculatePrice(p,pages,copies,clean(data.contentType),clean(data.color),clean(data.sides),clean(data.format)).baseTotal;
      let voucherCustomer=null;const managed=await accountManagementOn(env);if(managed){voucherCustomer=await requireCustomer(env,request);}const v=await validateVoucherServer(env,{code:data.code,subtotal,pages,copies,deliveryFee:num(data.deliveryFee),deviceId:clean(data.deviceId),customerId:voucherCustomer?.id||null,accountManaged:managed});
      return json({success:true,voucher:v.voucher,discount:v.discount});
    }
    if(action==='getPmInkPricing'){
      const ink=pmInkSettings(await getSettings(env));return json({success:true,pricing:{blackInkRate:centsToNumber(ink.blackInkRateCents).toFixed(2),colorInkRate:centsToNumber(ink.colorInkRateCents).toFixed(2),minimumInkCharge:centsToNumber(ink.minInkChargeCents).toFixed(2),coverageThreshold:String(ink.coverageThresholdPercent),rounding:'NEAREST_WHOLE_PESO_HALF_UP'}});
    }
    if(action==='getNotifications'){
      const managed=await accountManagementOn(env);
      if(managed){
        const c=await requireCustomer(env,request);
        const {results}=await env.DB.prepare(`SELECT id,order_id,type,title,message,created_at,read_at,category FROM notifications WHERE customer_id=? ORDER BY created_at DESC LIMIT 100`).bind(c.id).all();
        return json({success:true,notifications:results.map(n=>({id:n.id,orderId:n.order_id||'',type:n.type,title:n.title,message:n.message,createdAt:n.created_at,readAt:n.read_at,category:n.category||'system'}))});
      }
      const deviceId=clean(data.deviceId);if(!deviceId)return json({success:true,notifications:[]});
      const {results}=await env.DB.prepare(`SELECT n.id,n.order_id,n.type,n.title,n.message,n.created_at,n.read_at,n.category FROM notifications n INNER JOIN orders o ON o.id=n.order_id WHERE o.device_id=? ORDER BY n.created_at DESC LIMIT 100`).bind(deviceId).all();
      return json({success:true,notifications:results.map(n=>({id:n.id,orderId:n.order_id||'',type:n.type,title:n.title,message:n.message,createdAt:n.created_at,readAt:n.read_at,category:n.category||'printing'}))});
    }
    if(action==='markNotificationRead'){
      const nid=clean(data.notificationId);if(!nid)return json({success:false,error:'Notification ID is required.'},400);
      const managed=await accountManagementOn(env);
      if(managed){const c=await requireCustomer(env,request);await env.DB.prepare('UPDATE notifications SET read_at=? WHERE id=? AND customer_id=?').bind(now(),nid,c.id).run();}
      else{const deviceId=clean(data.deviceId);if(!deviceId)return json({success:false,error:'Missing notification information.'},400);await env.DB.prepare(`UPDATE notifications SET read_at=? WHERE id=? AND EXISTS(SELECT 1 FROM orders o WHERE o.id=notifications.order_id AND o.device_id=?)`).bind(now(),nid,deviceId).run();}
      return json({success:true});
    }
    if(action==='markNotificationsRead'){
      const ids=Array.isArray(data.notificationIds)?data.notificationIds.map(clean).filter(Boolean):[];if(!ids.length)return json({success:true});
      const managed=await accountManagementOn(env);
      if(managed){const c=await requireCustomer(env,request);for(const nid of ids)await env.DB.prepare('UPDATE notifications SET read_at=? WHERE id=? AND customer_id=?').bind(now(),nid,c.id).run();}
      else{const deviceId=clean(data.deviceId);if(!deviceId)return json({success:false,error:'Missing notification information.'},400);for(const nid of ids)await env.DB.prepare(`UPDATE notifications SET read_at=? WHERE id=? AND EXISTS(SELECT 1 FROM orders o WHERE o.id=notifications.order_id AND o.device_id=?)`).bind(now(),nid,deviceId).run();}
      return json({success:true});
    }
    if(action==='clearNotifications'){
      const managed=await accountManagementOn(env);
      if(managed){const c=await requireCustomer(env,request);await env.DB.prepare('DELETE FROM notifications WHERE customer_id=?').bind(c.id).run();}
      else{const deviceId=clean(data.deviceId);if(!deviceId)return json({success:false,error:'Missing notification information.'},400);await env.DB.prepare('DELETE FROM notifications WHERE id IN (SELECT n.id FROM notifications n INNER JOIN orders o ON o.id=n.order_id WHERE o.device_id=?)').bind(deviceId).run();}
      return json({success:true});
    }
    if(action==='createOrder')return json(await createOrder(env,data,origin,apiPrefix,request));

    const adminActions=['getAdminDashboard','getAdminOrders','updateOrderStatus','updateOrdersStatusBulk','setPrintingAvailability','setPickupLocation','setServiceMessage','getPricing','savePricing','getPmInkPricing','savePmInkPricing','saveInkOverride','getLocations','saveLocation','deleteLocation','createVoucher','listVouchers','setVoucherActive','resetPrintingData','clearPrintingStorage','getAccountSettings','setAccountManagement','getCustomerAccounts','createCustomerAccount','updateCustomerAccount','deleteCustomerAccount','resetCustomerPassword','getCustomerActivity','getCustomerVoucherLinks','setCustomerVoucherLinks','pushNotification'];
    if(adminActions.includes(action)){
      if(action==='setServiceMessage'){
        const user=await requireAdmin(env,request);const message=clean(data.message).slice(0,500);
        await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('service_message',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(message,now()).run();
        await log(env,user.username,'UPDATE_SERVICE_MESSAGE','PM PRINT service message updated.');return json({success:true,serviceMessage:message});
      }
      if(action==='clearPrintingStorage'){
        const user=await requireAdmin(env,request);let deleted=0;let cursor;
        do{const listed=await env.PRINT_FILES.list({prefix:'pmprint/orders/',cursor});for(const o of listed.objects||[]){try{await env.PRINT_FILES.delete(o.key);deleted++;}catch(_){}}cursor=listed.truncated?listed.cursor:undefined;}while(cursor);
        await log(env,user.username,'CLEAR_PRINTING_STORAGE',`Deleted ${deleted} PM PRINT R2 file(s).`);return json({success:true,deleted});
      }
      return json(await handleAdmin(env,request,action,data,origin,apiPrefix));
    }
    return err('Unknown PM PRINT API action.',404);
  }catch(e){return err(e.message||String(e));}
}
export default {fetch:handle};
