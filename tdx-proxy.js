/* =====================================================================
 *  tdx-proxy.js  —  車位通 的 TDX 後端代理
 * ---------------------------------------------------------------------
 *  為什麼需要它？
 *    TDX 的 client_secret 不能放在手機 App / 前端網頁，會被任何人看到。
 *    所以由這支後端保管金鑰、換 token、呼叫 TDX，再把整理好的資料給前端。
 *
 *  前端只要呼叫：  GET  /api/parking?lat=25.04&lng=121.56&radius=1000
 *  回傳：          [ {id,name,lat,lng,total,available,type,fee,ev}, ... ]
 *  （這正是 parking-finder.html 期待的格式，填好 PROXY_URL 就能用）
 *
 *  ── 安裝與啟動 ──────────────────────────────────────────────────
 *    1. 先到 https://tdx.transportdata.tw 註冊會員、取得 API 金鑰
 *       （Client Id / Client Secret，帳號審核最多約 3 個工作天）
 *    2. npm init -y && npm install express cors        （Node 18+ 內建 fetch）
 *    3. 設定環境變數後啟動：
 *         TDX_ID=你的ClientId  TDX_SECRET=你的ClientSecret  node tdx-proxy.js
 *    4. 部署：Render / Railway / Fly.io 免費方案都可，記得把
 *       TDX_ID、TDX_SECRET 設成該平台的環境變數，不要寫死在程式裡。
 *
 *  ※ 端點與欄位以 TDX 官方 Swagger 為準：
 *     https://tdx.transportdata.tw/api-service/swagger  (搜尋 Parking)
 *     各縣市回傳欄位略有差異，下方解析已做容錯，必要時依實際資料微調。
 * ===================================================================== */

const express = require('express');
const cors = require('cors');

const TDX_ID     = process.env.TDX_ID     || 'YOUR_CLIENT_ID';
const TDX_SECRET = process.env.TDX_SECRET || 'YOUR_CLIENT_SECRET';
const PORT       = process.env.PORT       || 3000;

const AUTH_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const API_BASE = 'https://tdx.transportdata.tw/api/basic/v1/Parking';

const app = express();
app.use(cors());                 // 允許前端跨網域呼叫

/* ---- 全台縣市（TDX 用的英文代碼）---- */
const CITIES = [
  ['Taipei',25.0375,121.5637],   ['NewTaipei',25.0169,121.4628],
  ['Keelung',25.1276,121.7392],  ['Taoyuan',24.9936,121.3010],
  ['Hsinchu',24.8039,120.9647],  ['HsinchuCounty',24.8387,121.0177],
  ['MiaoliCounty',24.5602,120.8214],['Taichung',24.1477,120.6736],
  ['ChanghuaCounty',24.0809,120.5385],['NantouCounty',23.9609,120.9719],
  ['YunlinCounty',23.7092,120.4313],['ChiayiCounty',23.4518,120.2555],
  ['Chiayi',23.4801,120.4491],   ['Tainan',22.9999,120.2270],
  ['Kaohsiung',22.6273,120.3014],['PingtungCounty',22.5519,120.5487],
  ['YilanCounty',24.7021,121.7378],['HualienCounty',23.9871,121.6015],
  ['TaitungCounty',22.7583,121.1444],
  ['PenghuCounty',23.5712,119.5793],['KinmenCounty',24.4321,118.3171],
  ['LienchiangCounty',26.1608,119.9512]
];

function haversine(a,b,c,d){
  const R=6371000,t=Math.PI/180;
  const x=Math.sin((c-a)*t/2)**2+Math.cos(a*t)*Math.cos(c*t)*Math.sin((d-b)*t/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
function nearestCity(la,lo){
  let best=CITIES[0],bd=1e15;
  for(const c of CITIES){const dd=haversine(la,lo,c[1],c[2]);if(dd<bd){bd=dd;best=c;}}
  return best[0];
}

/* ---- Token 快取：到期前重複使用，避免每次都重新換 ---- */
let tokenCache={value:null,exp:0};
async function getToken(){
  if(tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const body=new URLSearchParams({
    grant_type:'client_credentials',
    client_id:TDX_ID,
    client_secret:TDX_SECRET
  });
  const r=await fetch(AUTH_URL,{
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body
  });
  if(!r.ok) throw new Error('取得 token 失敗：'+r.status+' '+await r.text());
  const j=await r.json();
  tokenCache={ value:j.access_token, exp:Date.now()+(j.expires_in-60)*1000 }; // 提前 60 秒過期
  return tokenCache.value;
}

async function tdxGet(path){
  const token=await getToken();
  const r=await fetch(API_BASE+path,{
    headers:{ authorization:'Bearer '+token, 'accept-encoding':'gzip' }
  });
  if(r.status===401){ tokenCache={value:null,exp:0}; }     // token 失效就清掉重抓
  if(!r.ok) throw new Error('TDX '+path+' 回傳 '+r.status);
  return r.json();
}

// 依序嘗試多個候選端點，回傳第一個成功的（官方資料標準與實際 API 命名略有差異，故容錯）
async function tryGet(paths){
  let lastErr;
  for(const p of paths){
    try{ return await tdxGet(p); }catch(e){ lastErr=e; }
  }
  throw lastErr||new Error('all endpoints failed');
}

// 路邊路段常以線段(WKT)表示，取第一個點當作地圖標記位置；WKT 為「經度 緯度」順序
function firstPoint(geo){
  if(!geo||typeof geo!=='string') return null;
  const m=geo.match(/(-?\d+\.\d+)\s+(-?\d+\.\d+)/);
  return m?{lng:parseFloat(m[1]),lat:parseFloat(m[2])}:null;
}

// 從一筆動態資料取出汽車可用車位 {available,total}
function pickAvail(a){
  let available=a.AvailableSpaces, total=a.TotalSpaces ?? a.NumberOfSpaces;
  if(Array.isArray(a.Availabilities)){                   // 標準格式：依車種分列，SpaceType 1=汽車
    const car=a.Availabilities.find(x=>x.SpaceType===1)||a.Availabilities[0];
    if(car){
      available=car.AvailableSpaces ?? car.NumberOfAvailable ?? available;
      total=car.NumberOfSpaces ?? total;
    }
  }
  return {available, total};
}
function asArray(x){ return Array.isArray(x)?x:(x&&typeof x==='object'?(Object.values(x).find(Array.isArray)||[]):[]); }

/* ====================================================================
 *  省額度快取策略
 *    靜態資料（名稱/座標/總車位）幾乎不變 → 一天抓一次
 *    動態車位 → 每縣市最多每 DYN_TTL 抓一次；期間所有查詢都讀快取
 *    完全不跑背景輪詢，沒人查就不花額度（適合免費 3,000 次/月）
 * ==================================================================== */
const STATIC_TTL = 24*3600*1000;                       // 靜態：24 小時
const DYN_TTL    = Number(process.env.DYN_TTL_MS) || 180000;  // 動態：預設 3 分鐘

const staticCache={};   // city -> {t, off:[...], on:[...]}
const dynCache={};      // city -> {t, map:{ id -> {available,total} }}

/* ---- 靜態資料 ---- */
async function loadStaticOff(city){
  const carparks=await tryGet([`/OffStreet/CarPark/City/${city}?%24format=JSON`]);
  const out=[];
  for(const cp of asArray(carparks)){
    const pos=cp.CarParkPosition||{};
    if(pos.PositionLat==null||pos.PositionLon==null) continue;
    out.push({
      id:'off:'+cp.CarParkID,
      name:(cp.CarParkName&&(cp.CarParkName.Zh_tw||cp.CarParkName))||'停車場',
      lat:pos.PositionLat, lng:pos.PositionLon,
      totalStatic:cp.TotalSpaces ?? null,
      fee:(cp.FareDescription||'').slice(0,20)||'依現場標示',
      type:'路外'
    });
  }
  return out;
}
async function loadStaticOn(city){
  const segs=await tryGet([
    `/OnStreet/ParkingSegment/City/${city}?%24format=JSON`,
    `/OnStreet/CurbParkingSegment/City/${city}?%24format=JSON`
  ]);
  const out=[];
  for(const s of asArray(segs)){
    const id=s.ParkingSegmentID ?? s.SegmentID ?? s.CurbParkingSegmentID;
    if(id==null) continue;
    const pos=s.ParkingSegmentPosition||s.CurbParkingSegmentPosition||{};
    let lat=pos.PositionLat, lng=pos.PositionLon;
    if(lat==null||lng==null){
      const p=firstPoint(s.Geometry||s.Shape||s.RoadGeometry);
      if(p){lat=p.lat;lng=p.lng;}
    }
    if(lat==null||lng==null) continue;
    out.push({
      id:'on:'+id,
      name:(s.RoadName&&(s.RoadName.Zh_tw||s.RoadName))||
           (s.ParkingSegmentName&&(s.ParkingSegmentName.Zh_tw||s.ParkingSegmentName))||'路邊停車格',
      lat,lng,
      totalStatic:s.TotalSpaces ?? null,
      fee:(s.FareDescription||'').slice(0,20)||'依現場標示',
      type:'路邊'
    });
  }
  return out;
}
async function getStatic(city){
  const c=staticCache[city];
  if(c && Date.now()-c.t < STATIC_TTL) return c;
  const [off,on]=await Promise.all([
    loadStaticOff(city).catch(e=>{console.warn('static off',city,e.message);return [];}),
    loadStaticOn(city).catch(e=>{console.warn('static on',city,e.message);return [];})
  ]);
  return staticCache[city]={t:Date.now(),off,on};
}

/* ---- 動態車位 ---- */
async function loadDynOff(city){
  const avail=await tryGet([
    `/OffStreet/ParkingAvailability/City/${city}?%24format=JSON`,
    `/OffStreet/CarPark/Availability/City/${city}?%24format=JSON`
  ]);
  const map={};
  for(const a of asArray(avail)){
    if(a.CarParkID==null) continue;
    map['off:'+a.CarParkID]=pickAvail(a);
  }
  return map;
}
async function loadDynOn(city){
  const avail=await tryGet([
    `/OnStreet/ParkingSegmentAvailability/City/${city}?%24format=JSON`,
    `/OnStreet/CurbParkingSegment/Availability/City/${city}?%24format=JSON`
  ]);
  const map={};
  for(const a of asArray(avail)){
    const id=a.ParkingSegmentID ?? a.SegmentID ?? a.CurbParkingSegmentID;
    if(id==null) continue;
    map['on:'+id]=pickAvail(a);
  }
  return map;
}
async function getDynamic(city, force){
  const c=dynCache[city];
  if(!force && c && Date.now()-c.t < DYN_TTL) return c;
  const [off,on]=await Promise.all([
    loadDynOff(city).catch(e=>{console.warn('dyn off',city,e.message);return {};}),
    loadDynOn(city).catch(e=>{console.warn('dyn on',city,e.message);return {};})
  ]);
  return dynCache[city]={t:Date.now(),map:{...off,...on}};
}

/* ---- 合併靜態 + 動態，輸出前端格式 + 資料時間 ---- */
async function buildLots(city, force){
  const [s,d]=await Promise.all([getStatic(city), getDynamic(city, force)]);
  const lots=[];
  for(const base of [...s.off, ...s.on]){
    const av=d.map[base.id];
    if(!av || av.available==null) continue;             // 沒即時車位就跳過
    const available=Math.max(0,Number(av.available)||0);
    const total=Number(av.total ?? base.totalStatic ?? (available>0?available:0))||0;
    lots.push({
      id:base.id, name:base.name, lat:base.lat, lng:base.lng,
      total, available, type:base.type, fee:base.fee, ev:0
    });
  }
  return { lots, dataTime:d.t };
}

/* ---- 對外端點 ---- */
app.get('/api/parking', async (req,res)=>{
  const lat=parseFloat(req.query.lat), lng=parseFloat(req.query.lng);
  const radius=parseFloat(req.query.radius)||1000;
  const force=req.query.fresh==='1';                    // 使用者主動「立即更新」才強制抓
  if(isNaN(lat)||isNaN(lng)) return res.status(400).json({error:'缺少 lat / lng'});
  try{
    const city=nearestCity(lat,lng);
    const {lots,dataTime}=await buildLots(city, force);
    const near=lots
      .map(p=>({...p,_d:haversine(lat,lng,p.lat,p.lng)}))
      .filter(p=>p._d<=radius)
      .sort((a,b)=>a._d-b._d)
      .slice(0,40);
    res.json({ lots:near, dataTime, city });            // dataTime 供前端顯示「更新於 X 分鐘前」
  }catch(e){
    console.error(e);
    res.status(502).json({error:'TDX 讀取失敗',detail:String(e.message||e)});
  }
});

app.get('/', (req,res)=>res.send('車位通 TDX proxy 運作中。試試 /api/parking?lat=25.04&lng=121.56&radius=1000'));

app.listen(PORT, ()=>console.log(`tdx-proxy listening on :${PORT}`));
