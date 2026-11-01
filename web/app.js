/* Presentation and browser I/O only. Every book mutation, priority decision,
 * simulated order, tree, queue, hash chain and fill is computed in engine.c. */
const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const paths={terminal:'M3 4h18v16H3z M3 8h18 M7 12l3 2-3 2 M13 16h4',tree:'M12 3v5 M5 13V9h14v4 M3 14h4v5H3z M10 3h4v4h-4z M17 14h4v5h-4z',play:'M8 4l12 8-12 8z',pause:'M7 4h3v16H7z M14 4h3v16h-3z',chart:'M4 3v17h17 M8 15v-4 M13 15V7 M18 15V5',book:'M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1z M12 5v15',arrow:'M4 12h15 M13 6l6 6-6 6',external:'M14 3h7v7 M21 3L10 14 M10 3H3v18h18v-7',code:'M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 0-6 0 3 3 0 1 0 6 0',download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',sliders:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',lock:'M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4',shield:'M12 2L3 6v6c0 5 9 10 9 10s9-5 9-10V6z M8 12l3 3 5-6',info:'M12 8h.01 M11 11h1v6 M22 12a10 10 0 1 0-20 0 10 10 0 0 0 20 0',bolt:'M13 2L4 14h7l-1 8 10-13h-7z',trend:'M3 17l6-6 4 4 8-11 M15 4h6v6',layers:'M12 3L2 8l10 5 10-5z M2 12l10 5 10-5 M2 16l10 5 10-5',clock:'M12 7v5l4 2 M22 12a10 10 0 1 0-20 0 10 10 0 0 0 20 0',volume:'M4 18V9h3v9z M10 18V4h3v14z M16 18V7h3v11z'};
const icon=(name)=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.info}"/></svg>`;
function icons(root=document){$$('[data-icon]',root).forEach(el=>{el.innerHTML=icon(el.dataset.icon);});}
icons();
history.scrollRestoration='manual';
$$('a[data-view]').forEach(a=>a.addEventListener('click',()=>{if(location.hash===a.getAttribute('href'))window.scrollTo(0,0);}));

let engine, snapshot, side=0, activity='orders', chartMode='candles', treeSide=0;
let selectedLevel=null, selectedEvent=null, timer=null, scenarioTimer=null, toastTimer;
let currentView='terminal', durations=[], lastBenchmark=null, storageWarning=false;
let session={version:1,base:'market',scenario:0,commands:[]};
const key='tradecore.session.v1';
const money=(v)=>Number(v/100).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const num=(v)=>Number(v).toLocaleString('en-IN');
const compact=(v)=>Intl.NumberFormat('en-IN',{notation:'compact',maximumFractionDigits:1}).format(v);
const cstring=(ptr)=>{const bytes=new Uint8Array(engine.memory.buffer,ptr);return new TextDecoder().decode(bytes.subarray(0,bytes.indexOf(0)));};
const readSnapshot=()=>JSON.parse(cstring(engine.tc_snapshot()));
const toast=(message,error=false)=>{clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').className=`toast visible${error?' error':''}`;toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4600);};

function persist(){try{localStorage.setItem(key,JSON.stringify(session));}catch{if(!storageWarning){toast('Browser storage is unavailable. Export your session to keep it.',true);storageWarning=true;}}}
function call(name,args=[]){
  if(!engine)return false;
  if(session.commands.length>=10000){stopSimulation();toast('Session command limit reached. Export this session and start a new book.',true);return false;}
  const start=performance.now(),result=engine[name](...args),elapsed=performance.now()-start;
  durations.push(elapsed);if(durations.length>1000)durations.shift();
  session.commands.push([name,args]);persist();snapshot=readSnapshot();render();
  if(result<0){toast(cstring(engine.tc_error()),true);return false;}
  return result===undefined?true:result;
}
function baseEngine(data){if(data.base==='market')engine.tc_seed_market();else if(data.base==='scenario')engine.tc_scenario(data.scenario);else engine.tc_reset(42);}
function newSession(base='market',scenario=0){
  stopSimulation();stopScenario();session={version:1,base,scenario,commands:[]};baseEngine(session);
  durations=[];lastBenchmark=null;selectedLevel=null;selectedEvent=null;snapshot=readSnapshot();persist();render();
}
function validSession(data){
  if(!data||data.version!==1||!['market','empty','scenario'].includes(data.base)||!Array.isArray(data.commands)||data.commands.length>10000)return false;
  if(data.base==='scenario'&&(!Number.isInteger(data.scenario)||data.scenario<1||data.scenario>4))return false;
  let work=0;
  return data.commands.every(cmd=>{
    if(!Array.isArray(cmd)||cmd.length!==2||!Array.isArray(cmd[1])||!cmd[1].every(Number.isSafeInteger))return false;
    const [f,a]=cmd;let valid=false;work++;
    if(f==='tc_submit')valid=a.length===4&&[0,1].includes(a[0])&&a[1]>=1&&a[1]<=1e8&&a[2]>=1&&a[2]<=1e6&&[0,1].includes(a[3]);
    if(f==='tc_cancel')valid=a.length===1&&a[0]>0&&a[0]<2e9;
    if(f==='tc_replace')valid=a.length===3&&a[0]>0&&a[0]<2e9&&a[1]>=1&&a[1]<=1e8&&a[2]>=1&&a[2]<=1e6;
    if(f==='tc_simulate'){valid=a.length===1&&a[0]>0&&a[0]<=1000;work+=a[0];}
    if(f==='tc_scenario_next'){valid=a.length===0;work+=data.scenario===4?2050:1;}
    return valid&&work<=100000;
  });
}
function restore(data){baseEngine(data);data.commands.forEach(([name,args])=>engine[name](...args));session={version:1,base:data.base,scenario:data.scenario||0,commands:data.commands};snapshot=readSnapshot();selectedLevel=null;selectedEvent=null;durations=[];lastBenchmark=null;persist();render();}
function download(name,body,type){const url=URL.createObjectURL(new Blob([body],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function exportSession(){if(!snapshot)return;download('TradeCore-session.json',JSON.stringify({...session,exportedAt:new Date().toISOString(),snapshot},null,2),'application/json');toast('Session exported with its replayable command log.');}
function stopSimulation(){if(timer)clearInterval(timer);timer=null;$('#simulation-toggle').classList.remove('running');$('#simulation-toggle').innerHTML=`${icon('play')}<span>Start simulation</span>`;}
function startSimulation(){stopScenario();if(timer){stopSimulation();return;}if(!engine)return;
  $('#simulation-toggle').classList.add('running');$('#simulation-toggle').innerHTML=`${icon('pause')}<span>Pause simulation</span>`;
  const rate=Number($('#simulation-speed').value);timer=setInterval(()=>call('tc_simulate',[1]),1000/rate);
}
function stopScenario(){if(scenarioTimer)clearInterval(scenarioTimer);scenarioTimer=null;$('#scenario-play').innerHTML=`${icon('play')}Auto play`;}

const pages={terminal:['Market terminal','Place an order. Watch the market find its match.'],laboratory:['DSA laboratory','A closer look at the structures doing the work.'],scenarios:['Scenario studio','Your next demonstration, already rehearsed.'],metrics:['Engine metrics','Every operation leaves something worth measuring.'],guide:['How it works','From one C source file to a market you can explore.']};
function navigate(){const v=location.hash.slice(1);currentView=pages[v]?v:'terminal';
  $$('.view').forEach(el=>el.classList.toggle('active',el.id===`view-${currentView}`));
  $$('[data-view]').forEach(el=>{el.classList.toggle('active',el.dataset.view===currentView);if(el.dataset.view===currentView)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  $('#breadcrumb').textContent=pages[currentView][0];$('#page-title').textContent=pages[currentView][0];$('#page-description').textContent=pages[currentView][1];window.scrollTo(0,0);if(snapshot)render();
}
window.addEventListener('hashchange',navigate);

function sparkline(trades){if(trades.length<2)return '';const p=trades.slice(-35).map(t=>t.price),lo=Math.min(...p),range=Math.max(...p)-lo||1;
  const points=p.map((v,i)=>`${i*70/(p.length-1)},${28-(v-lo)/range*25}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 72 32" aria-hidden="true"><polyline points="${points}" fill="none" stroke="#8fa979" stroke-width="1.4"/></svg>`;
}
function stat(label,value,note,ico,extra=''){return `<div class="stat-card"><div class="stat-label">${icon(ico)}${label}</div><div class="stat-value">${value}</div><div class="stat-note">${note}</div>${extra}</div>`;}
function renderTerminal(){
  const s=snapshot.stats,t=snapshot.trades,last=t.length?t[t.length-1].price:s.lastPrice;
  const spread=s.bid&&s.ask?s.ask-s.bid:0;
  $('#terminal-stats').innerHTML=stat(t.length?'Last traded price':'Reference price',`₹${money(last)}`,t.length?`${num(s.fills)} fills this session`:'No executions yet','trend',sparkline(t))+
    stat('Executed volume',compact(s.volume),'Simulated shares exchanged','volume')+
    stat('Active orders',num(s.active),`${num(s.levels)} price levels in the book`,'layers')+
    stat('Bid / ask spread',spread?`₹${money(spread)}`:'—',spread?'Best ask minus best bid':'Waiting for both sides','chart');
  $('#chart-price').textContent=`₹${money(last)}`;$('#chart-range').textContent=t.length?`${Math.min(t.length,960)} recent fills`:'No fills yet';
  drawChart();renderBook();renderActivity();updateValue();
}
function drawChart(){const root=$('#price-chart'),trades=snapshot.trades.slice(-960);
  if(!trades.length){root.innerHTML='<div class="chart-empty">Your chart begins with the first trade.<br>Place matching orders or start a simulation.</div>';return;}
  const candles=snapshot.candles?.slice(-60)||[];
  const w=600,h=280,l=6,r=67,top=17,bottom=220,plotW=w-l-r;
  const values=chartMode==='candles'&&candles.length?candles.flatMap(c=>[c.high,c.low]):trades.map(t=>t.price);
  const rawLow=Math.min(...values),rawHigh=Math.max(...values),pad=Math.max((rawHigh-rawLow)*.15,30),low=rawLow-pad,high=rawHigh+pad;
  const y=p=>top+(high-p)/(high-low)*(bottom-top),x=(i,n)=>l+(i+.5)*plotW/n;
  let svg=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="TCX simulated execution prices"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#b7cda0" stop-opacity=".3"/><stop offset="100%" stop-color="#edf4e6" stop-opacity=".02"/></linearGradient></defs>`;
  for(let i=0;i<5;i++){const p=high-(high-low)*i/4,yy=y(p);svg+=`<line x1="${l}" y1="${yy}" x2="${w-r+4}" y2="${yy}" stroke="#edf1e7" stroke-dasharray="3 4"/><text x="${w-r+12}" y="${yy+3}" font-size="9" fill="#a6b098" font-family="DM Sans,Segoe UI,sans-serif">${money(p)}</text>`;}
  if(chartMode==='candles'&&candles.length){const maxVol=Math.max(...candles.map(c=>c.volume),1),bw=Math.max(1,Math.min(6,plotW/candles.length*.55));
    candles.forEach((c,i)=>{const xx=x(i,candles.length),color=c.close>=c.open?'#86a86a':'#ce9986',yy=Math.min(y(c.open),y(c.close)),hh=Math.max(1,Math.abs(y(c.open)-y(c.close)));
      svg+=`<line x1="${xx}" y1="${y(c.high)}" x2="${xx}" y2="${y(c.low)}" stroke="${color}" stroke-width="1"/><rect x="${xx-bw/2}" y="${yy}" width="${bw}" height="${hh}" fill="${color}" rx=".5"/><rect x="${xx-bw/2}" y="${263-c.volume/maxVol*25}" width="${bw}" height="${c.volume/maxVol*25}" fill="${color}" opacity=".27"/>`;
    });
  }else{const ps=trades.slice(-160),points=ps.map((t,i)=>`${x(i,ps.length)},${y(t.price)}`).join(' '),first=x(0,ps.length),last=x(ps.length-1,ps.length);
    svg+=`<polygon points="${first},${bottom} ${points} ${last},${bottom}" fill="url(#chart-fill)"/><polyline points="${points}" fill="none" stroke="#83a369" stroke-width="1.8"/>`;
    const maxV=Math.max(...ps.map(t=>t.quantity));ps.forEach((t,i)=>{svg+=`<rect x="${x(i,ps.length)}" y="${263-t.quantity/maxV*24}" width="${Math.max(1,plotW/ps.length*.55)}" height="${t.quantity/maxV*24}" fill="#c3d3b3" opacity=".6"/>`;});
  }
  const last=trades[trades.length-1].price,yy=y(last);
  svg+=`<line x1="${l}" y1="${yy}" x2="${w-r+5}" y2="${yy}" stroke="#8bab75" stroke-width=".8" stroke-dasharray="3 3"/><rect x="${w-r+6}" y="${yy-8}" width="59" height="16" rx="2" fill="#8eaa76"/><text x="${w-r+35}" y="${yy+3}" text-anchor="middle" font-size="8.5" fill="white" font-family="DM Sans,Segoe UI,sans-serif">${money(last)}</text>`;
  svg+=`<text x="8" y="277" font-size="8" fill="#aab59b">OLDER FILLS</text><text x="${w-r-9}" y="277" text-anchor="end" font-size="8" fill="#aab59b">MOST RECENT</text></svg>`;root.innerHTML=svg;
}
function renderBook(){const s=snapshot.stats;
  for(const [name,sideValue] of [['ask',1],['bid',0]]){let ls=(sideValue?snapshot.asks:snapshot.bids).slice(0,6);if(sideValue)ls=ls.reverse();
    const max=Math.max(...ls.map(l=>l.quantity),1);
    $(`#${name}-book`).innerHTML=ls.length?ls.map(l=>`<button class="book-row ${name}" data-level="${l.price}" data-book-side="${sideValue}" style="--depth:${Math.max(8,l.quantity/max*91)}%" title="Inspect ${num(l.count)} orders at ₹${money(l.price)}"><span>${money(l.price)}</span><span>${num(l.quantity)}</span><span>${l.count}</span></button>`).join(''):`<div class="book-empty">No ${name==='bid'?'buy':'sell'} orders yet</div>`;
  }
  $('#book-spread').innerHTML=`<strong>₹${money(s.lastPrice)} <span>↕</span></strong><span>${s.bid&&s.ask?`Spread ₹${money(s.ask-s.bid)}`:'Waiting for liquidity'}</span>`;
}
function renderActivity(){
  $('#order-count').textContent=num(snapshot.stats.active);$('#trade-count').textContent=num(snapshot.stats.fills);
  const manual=$('#manual-only').checked;
  if(activity==='orders'){
    const list=[...snapshot.orders].filter(o=>!manual||o.owner===0).sort((a,b)=>b.id-a.id).slice(0,80);
    const state=['Open','Partially filled','Filled','Cancelled','Replaced'];
    $('#activity-content').innerHTML=`<table><thead><tr><th>Order ID</th><th>Side</th><th>Limit price</th><th>Quantity</th><th>Filled / total</th><th>Status</th><th>Participant</th><th>Actions</th></tr></thead><tbody>${list.map(o=>`<tr><td>#TC-${String(o.id).padStart(4,'0')}</td><td><span class="side-badge ${o.side?'sell':''}">${o.side?'SELL':'BUY'}</span></td><td>₹${money(o.price)}</td><td>${num(o.remaining)}</td><td>${num(o.initial-o.remaining)} / ${num(o.initial)}</td><td><span class="state-pill ${state[o.state].toLowerCase()}">${state[o.state]}</span></td><td>${o.owner?'Simulator':'You'}</td><td>${o.state<2?`<div class="row-actions"><button data-replace="${o.id}">Replace</button><button data-cancel="${o.id}">Cancel</button></div>`:'—'}</td></tr>`).join('')||'<tr class="empty-row"><td colspan="8">Your first order starts here. Place one above or load a scenario.</td></tr>'}</tbody></table>`;
    $('#activity-caption').textContent='View: up to 120 active and 60 recent completed orders; newest 80 shown. Replacement quantity means new remaining shares.';
  }else{
    const manualIds=new Set(snapshot.orders.filter(o=>o.owner===0).map(o=>o.id));
    const list=[...snapshot.trades].reverse().filter(t=>!manual||manualIds.has(t.maker)||manualIds.has(t.taker)).slice(0,80);
    $('#activity-content').innerHTML=`<table><thead><tr><th>Fill ID</th><th>Taker side</th><th>Execution price</th><th>Shares</th><th>Maker order</th><th>Taker order</th><th>Command</th></tr></thead><tbody>${list.map(t=>`<tr><td>#F-${String(t.id).padStart(4,'0')}</td><td><span class="side-badge ${t.side?'sell':''}">${t.side?'SELL':'BUY'}</span></td><td>₹${money(t.price)}</td><td>${num(t.quantity)}</td><td>#${t.maker}</td><td>#${t.taker}</td><td>seq ${t.sequence}</td></tr>`).join('')||'<tr class="empty-row"><td colspan="7">No matching executions in this view yet.</td></tr>'}</tbody></table>`;
    $('#activity-caption').textContent=manual?'Manual filter uses IDs in the current bounded order window. Older participant records may not be retained.':'Showing the newest 80 retained fills. The C history ring retains up to 2,048 fills; export the command log for full replay.';
  }
}
function inspectLevel(value,ss){selectedLevel={price:value,side:ss};treeSide=ss;$$('[data-tree]').forEach(b=>b.classList.toggle('active',Number(b.dataset.tree)===ss));location.hash='laboratory';renderLab();}
function renderLab(){
  const map=new Map(snapshot.tree.map(n=>[n.index,n])),root=map.get(snapshot.roots[treeSide]);
  const nodes=[];let count=0,maxDepth=0;
  function layout(n,depth){if(!n||depth>9||nodes.length>100)return;layout(map.get(n.left),depth+1);n.drawX=count++;n.drawY=depth;maxDepth=Math.max(maxDepth,depth);nodes.push(n);layout(map.get(n.right),depth+1);}
  if(root)layout(root,0);
  if(!selectedLevel||!map.size){const b=(treeSide?snapshot.asks:snapshot.bids)[0];if(b)selectedLevel={price:b.price,side:treeSide};}
  if(nodes.length){const w=Math.max(500,nodes.length*72),h=Math.max(250,(maxDepth+1)*67+20),pos=new Map(nodes.map(n=>[n.index,{x:40+n.drawX*(w-80)/Math.max(1,count-1),y:28+n.drawY*66}]));
    if(count===1)pos.set(nodes[0].index,{x:w/2,y:28});
    let svg=`<svg viewBox="0 0 ${w} ${h}" style="min-width:${Math.min(1400,w)}px" role="img" aria-label="Actual ${treeSide?'ask':'bid'} AVL tree"><title>AVL price levels. Click a node to inspect FIFO.</title>`;
    nodes.forEach(n=>{const p=pos.get(n.index);for(const child of [n.left,n.right]){const q=pos.get(child);if(q)svg+=`<path d="M${p.x} ${p.y+15}L${q.x} ${q.y-15}" stroke="#dce7cf" stroke-width="1.5"/>`;}});
    nodes.forEach(n=>{const p=pos.get(n.index),selected=selectedLevel?.side===n.side&&selectedLevel.price===n.price,highlight=selectedEvent?.price===n.price;
      svg+=`<g class="tree-node" data-node-price="${n.price}" data-node-side="${n.side}" tabindex="0" role="button" aria-label="${money(n.price)} rupees, ${n.count} orders, balance ${n.balance}"><rect x="${p.x-33}" y="${p.y-16}" width="66" height="33" rx="6" fill="${highlight?'#f7edce':selected?'#dfeccb':'#f8fbf2'}" stroke="${selected?'#93b272':'#dce7ce'}"/><text x="${p.x}" y="${p.y-1}" text-anchor="middle" font-size="9" font-family="DM Sans,Segoe UI,sans-serif" fill="#6a854e">${money(n.price)}</text><text x="${p.x}" y="${p.y+10}" text-anchor="middle" font-size="6.5" fill="#9aaa87">h${n.height} · bf ${n.balance} · ${n.count} orders</text></g>`;});
    $('#tree-canvas').innerHTML=svg+'</svg>';
  }else $('#tree-canvas').innerHTML='<div class="empty-state">This side has no active price levels.<br>Add an order or try the AVL rotations scenario.</div>';
  $('#tree-stats').textContent=`${snapshot.stats.rotations} rotations · ${snapshot.stats.levels} total levels · showing ${nodes.length} on this side`;
  if(selectedLevel){const queue=JSON.parse(cstring(engine.tc_queue(selectedLevel.side,selectedLevel.price)));
    $('#fifo-price').textContent=`${selectedLevel.side?'ASK':'BID'} ₹${money(selectedLevel.price)}`;
    $('#fifo-queue').innerHTML=queue.length?queue.map((o,i)=>`${i?'<span class="queue-arrow">⇄</span>':''}<div class="queue-node ${i===0?'head':''}">${i===0?'<span>HEAD · FIRST TO FILL</span>':i===queue.length-1?'<span>TAIL</span>':''}<strong>#${o.id}</strong><small>${num(o.remaining)} shares</small><small>sequence ${o.sequence}</small></div>`).join(''):'<div class="empty-state">This level is no longer active. Select another price.</div>';
  }else{$('#fifo-price').textContent='SELECT A PRICE';$('#fifo-queue').innerHTML='<div class="empty-state">Select a price node or an order-book row to inspect its queue.</div>';}
  const descriptions={1:['Order accepted','A valid incoming order enters the C matching loop.'],2:['AVL comparison','The engine compares a price with an AVL node to find its level.'],3:['Right rotation','A right rotation restores AVL balance while preserving price ordering.'],4:['Left rotation','A left rotation restores AVL balance while preserving price ordering.'],5:['FIFO append','The remaining quantity joins the tail at its limit price.'],6:['Trade executed','The incoming order takes quantity from the head resting order at the maker price.'],7:['Price level created','A new AVL node is inserted because this side has no level at this price.'],8:['Empty level removed','The last order leaves this price. The AVL node is deleted and the tree rebalanced.'],9:['Hash entry added','The active order ID is hashed into a bucket linked to its order node.'],10:['Order cancelled','Only the unfilled remainder is removed. Hash and linked-list references are updated.']};
  $('#event-list').innerHTML=[...snapshot.events].reverse().slice(0,48).map(e=>`<button class="event-row ${selectedEvent?.serial===e.serial?'selected':''}" data-event="${e.serial}"><span class="event-type">${['','IN','<','↶','↷','+','✓','N','−','#','×'][e.code]}</span><span><strong>${descriptions[e.code]?.[0]||'Event'}</strong> ${e.order?`#${e.order}`:''}<small>seq ${e.sequence} · ₹${money(e.price)}${e.code===6?` · ${e.quantity} shares`:''}</small></span></button>`).join('')||'<div class="empty-state">The next command will leave a trace.</div>';
  if(selectedEvent){const e=selectedEvent;$('#trace-detail').textContent=`${descriptions[e.code]?.[1]||''} Event ${e.serial}, command ${e.sequence}. ${e.code===9?`Bucket ${e.quantity}.`:''}`;}
  $('#hash-table').innerHTML=snapshot.hash.map(b=>`<div class="hash-row ${b.ids.length>1?'collision':''}"><span class="hash-bucket">[${b.bucket}]</span><span>→</span>${b.ids.map((id,i)=>`${i?'<span>→</span>':''}<span class="hash-order">#${id}</span>`).join('')}</div>`).join('')||'<div class="empty-state">No active orders to index yet.</div>';
}
const scenarios=[
  {id:1,title:'Price-time priority',tag:'THE ESSENTIALS',desc:'Two sellers, one price. Discover why arrival order matters.',steps:[['Sell 80 @ ₹100','S1 is first in the FIFO.'],['Sell 70 @ ₹100','S2 joins behind S1.'],['Sell 100 @ ₹101','A new price level is created.'],['Sell 40 @ ₹102','An offer outside the next buyer’s limit.'],['Buy 200 @ ₹101','80 from S1, 70 from S2, then 50 from S3.'],['Buy 80 @ ₹101','50 fill; the remaining 30 become a bid.']]},
  {id:2,title:'Partial fills',tag:'QUANTITY, CONSERVED',desc:'Follow an order through several makers and a resting remainder.',steps:[['Rest 80 @ ₹100','First seller.'],['Rest 70 @ ₹100','Second seller, same FIFO.'],['Rest 100 @ ₹101','Third seller at the next price.'],['Rest 40 @ ₹102','This limit is not reachable by the buyers.'],['Buy 200 @ ₹101','Maker S3 is left partially filled: 50 shares.'],['Buy another 80 @ ₹101','50 execute and 30 rest. Every share is accounted for.']]},
  {id:3,title:'AVL rotations',tag:'WATCH THE TREE BALANCE',desc:'Insert ascending prices and inspect actual left rotations.',steps:Array.from({length:7},(_,i)=>[`Sell 20 @ ₹${100+i}`,i===2?'A left rotation restores balance.':'Inspect the node heights and balance factors.'])},
  {id:4,title:'Hash collisions',tag:'SAME BUCKET, TWO IDS',desc:'Create a real collision, then unlink an order by its ID.',steps:[['Create order #1','ID 1 enters bucket 433.'],['Advance to order #2049','2,046 intermediate orders match immediately; IDs 1 and 2049 share bucket 433.'],['Cancel order #1','Traverse the collision chain, find ID 1 and unlink it.']]}
];
function renderScenarios(){const id=snapshot.stats.scenario,sc=scenarios.find(x=>x.id===id),step=snapshot.stats.scenarioStep;
  $('#scenario-cards').innerHTML=scenarios.map(s=>`<button class="scenario-card ${id===s.id?'selected':''}" data-scenario="${s.id}"><span class="scenario-index">0${s.id} / ${s.tag}</span><h3>${s.title}</h3><p>${s.desc}</p><span class="scenario-start">${id===s.id?'Restart scenario':'Start scenario'}<span>↗</span></span></button>`).join('');
  if(!sc){$('#scenario-next').disabled=true;$('#scenario-play').disabled=true;$('#scenario-title').textContent='Choose a scenario to begin';$('#scenario-subtitle').textContent='Scenarios start a new local session.';$('#scenario-steps').innerHTML='<div class="empty-state">Start with Price-time priority for a teacher-friendly demonstration.</div>';$('#scenario-result').innerHTML='<h3>One command. A visible result.</h3><p>Choose a scenario above. Watch the order book change, then open the laboratory to inspect its structures.</p>';return;}
  const done=step>=sc.steps.length;$('#scenario-next').disabled=done;$('#scenario-play').disabled=done;
  $('#scenario-title').textContent=sc.title;$('#scenario-subtitle').textContent=done?'Scenario complete. Restart above or inspect the laboratory.':`Command ${Math.min(step+1,sc.steps.length)} of ${sc.steps.length} · engine pauses after each command`;
  $('#scenario-steps').innerHTML=sc.steps.map(([title,desc],i)=>`<div class="scenario-step ${i<step?'done':''} ${i===step?'current':''}"><span class="step-number">${i<step?'✓':i+1}</span><div><strong>${title}</strong><small>${desc}</small></div></div>`).join('');
  const s=snapshot.stats;
  $('#scenario-result').innerHTML=`<h3>${done?'Preset completed.':step?'Here’s what changed.':'Ready when you are.'}</h3><p>${done&&(id===1||id===2)?'Expected preset outcome: 250 shares in four fills, a bid for 30 at ₹101 and an ask for 40 at ₹102. Counters below show the current session, including any later commands.':step?sc.steps[step-1][1]:'Press Next command to begin. Each step goes through the real C engine.'}</p><div class="result-stat"><span>Executed shares</span><strong>${num(s.volume)}</strong></div><div class="result-stat"><span>Active orders / price levels</span><strong>${s.active} / ${s.levels}</strong></div><div class="result-stat"><span>AVL rotations</span><strong>${s.rotations}</strong></div><a class="button secondary" href="#laboratory">Inspect the data structures ↗</a>`;
  if(done)stopScenario();
}
function percentile(arr,p){if(!arr.length)return null;const sorted=[...arr].sort((a,b)=>a-b);return sorted[Math.ceil(p*sorted.length)-1];}
function renderMetrics(){const s=snapshot.stats,p50=percentile(durations,.5),p95=percentile(durations,.95);
  $('#metrics-stats').innerHTML=stat('Median command call',p50===null?'—':`${p50.toFixed(3)} <small>ms</small>`,`${durations.length} measured calls on this device`,'clock')+
    stat('p95 command call',p95===null?'—':`${p95.toFixed(3)} <small>ms</small>`,'Includes tracing · excludes UI / JSON','trend')+
    stat('Reserved C buffers',`${(s.reservedBytes/1048576).toFixed(2)} <small>MiB</small>`,'Fixed pools · excludes WASM stack','layers')+
    stat('Last benchmark',lastBenchmark?`${compact(lastBenchmark.rate)} <small>/s</small>`:'—',lastBenchmark?`${lastBenchmark.ms.toFixed(2)} ms / 1,000 commands`:'Run a benchmark to measure','bolt');
  const rows=[['Accepted commands',s.accepted],['Rejected commands',s.rejected],['Price comparisons',s.comparisons],['Hash lookup probes',s.hashProbes],['AVL rotations',s.rotations],['Executed fills',s.fills]];const max=Math.max(...rows.map(r=>r[1]),1);
  $('#operation-metrics').innerHTML=rows.map(([label,value])=>`<div class="operation-metric"><div><span>${label}</span><strong>${num(value)}</strong></div><div class="operation-track"><span style="width:${value/max*100}%"></span></div></div>`).join('');
}
function render(){if(!snapshot)return;renderTerminal();if(currentView==='laboratory')renderLab();if(currentView==='scenarios')renderScenarios();if(currentView==='metrics')renderMetrics();}
function decimalPrice(value){if(!/^\d+(?:\.\d{1,2})?$/.test(value))return null;const [whole,cents='']=value.split('.');const v=Number(whole)*100+Number(cents.padEnd(2,'0'));return Number.isSafeInteger(v)&&v>=1&&v<=100000000?v:null;}
function updateValue(){const p=decimalPrice($('#order-price').value),q=Number($('#order-quantity').value);$('#order-value').textContent=p&&Number.isInteger(q)&&q>0?`₹${money(p*q)}`:'—';}
function checkInvariants(){if(!engine)return;const ok=engine.tc_check()===1;$('#invariant-result').innerHTML=`${icon('shield')}<div><strong>${ok?'PASS — the current book satisfies every engine invariant.':'FAIL — export this session for investigation.'}</strong><p>Checked AVL ordering and balance, FIFO links and sequence, quantities, hash entries, pool accounting and price separation.</p></div>`;toast(ok?'All current-book invariants pass.':'Invariant failure. Export this session.',!ok);}

$('#simulation-toggle').addEventListener('click',startSimulation);
$('#simulation-speed').addEventListener('change',()=>{if(timer){stopSimulation();startSimulation();}});
$('#export-session').addEventListener('click',exportSession);$('#dialog-export').addEventListener('click',exportSession);
$('#session-menu').addEventListener('click',()=>$('#session-dialog').showModal());$('#close-session').addEventListener('click',()=>$('#session-dialog').close());
$('#reset-empty').addEventListener('click',()=>{newSession('empty');$('#session-dialog').close();toast('Empty book ready. Place your first order.');});
function loadMarket(){newSession('market');$('#order-price').value=money(snapshot.stats.lastPrice).replaceAll(',','');updateValue();toast('Sample market loaded. Every fill was generated by C.');}
$('#market-reset').addEventListener('click',loadMarket);$('#dialog-market').addEventListener('click',()=>{loadMarket();$('#session-dialog').close();});
$('#import-session').addEventListener('click',()=>$('#session-file').click());
$('#session-file').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>5e6)throw Error('Session file is too large.');const data=JSON.parse(await file.text());if(!validSession(data))throw Error('This file is not a supported TradeCore session or exceeds replay limits.');stopSimulation();stopScenario();restore(data);$('#session-dialog').close();toast('Session replayed successfully through the C engine.');}catch(error){toast(error.message,true);}finally{e.target.value='';}});
$$('[data-side]').forEach(b=>b.addEventListener('click',()=>{side=Number(b.dataset.side);$$('[data-side]').forEach(x=>x.classList.toggle('active',x===b));$('#submit-order').classList.toggle('sell-mode',side===1);$('#submit-order').innerHTML=`Place ${side?'sell':'buy'} order <span>↗</span>`;}));
$('#order-price').addEventListener('input',updateValue);$('#order-quantity').addEventListener('input',updateValue);
$$('[data-qty]').forEach(b=>b.addEventListener('click',()=>{$('#order-quantity').value=b.dataset.qty;updateValue();}));
$('#quantity-minus').addEventListener('click',()=>{$('#order-quantity').value=Math.max(1,(Number($('#order-quantity').value)||1)-1);updateValue();});
$('#quantity-plus').addEventListener('click',()=>{$('#order-quantity').value=Math.min(1e6,(Number($('#order-quantity').value)||1)+1);updateValue();});
$('#use-market').addEventListener('click',()=>{if(!snapshot)return;const p=side?snapshot.stats.bid:snapshot.stats.ask;$('#order-price').value=((p||snapshot.stats.lastPrice)/100).toFixed(2);updateValue();});
$('#order-form').addEventListener('submit',e=>{e.preventDefault();const p=decimalPrice($('#order-price').value),q=Number($('#order-quantity').value);if(!p||!Number.isInteger(q)||q<1||q>1e6){toast('Enter a valid price with up to two decimals and a whole-share quantity.',true);return;}const id=call('tc_submit',[side,p,q,0]);if(id!==false)toast(`Order #${id} accepted. ${side?'Sell':'Buy'} ${q} TCX at a limit of ₹${money(p)}.`);});
$$('[data-chart]').forEach(b=>b.addEventListener('click',()=>{chartMode=b.dataset.chart;$$('[data-chart]').forEach(x=>x.classList.toggle('active',x===b));if(snapshot)drawChart();}));
$$('[data-activity]').forEach(b=>b.addEventListener('click',()=>{activity=b.dataset.activity;$$('[data-activity]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-selected',String(x===b));});if(snapshot)renderActivity();}));
$('#manual-only').addEventListener('change',()=>snapshot&&renderActivity());
$('#export-trades').addEventListener('click',()=>{if(!snapshot)return;const rows=['fill_id,maker_order_id,taker_order_id,price_inr,quantity,taker_side,command_sequence',...snapshot.trades.map(t=>`${t.id},${t.maker},${t.taker},${(t.price/100).toFixed(2)},${t.quantity},${t.side?'SELL':'BUY'},${t.sequence}`)];download('TradeCore-trades.csv',rows.join('\r\n'),'text/csv');toast(`Exported ${snapshot.trades.length} retained fills.`);});
document.addEventListener('click',e=>{
  const level=e.target.closest('[data-level]');if(level)inspectLevel(Number(level.dataset.level),Number(level.dataset.bookSide));
  const node=e.target.closest('[data-node-price]');if(node){selectedLevel={price:Number(node.dataset.nodePrice),side:Number(node.dataset.nodeSide)};renderLab();}
  const ev=e.target.closest('[data-event]');if(ev){selectedEvent=snapshot.events.find(x=>x.serial===Number(ev.dataset.event));if(selectedEvent)treeSide=selectedEvent.side;$$('[data-tree]').forEach(b=>b.classList.toggle('active',Number(b.dataset.tree)===treeSide));renderLab();}
  const cancel=e.target.closest('[data-cancel]');if(cancel&&call('tc_cancel',[Number(cancel.dataset.cancel)])!==false)toast(`Order #${cancel.dataset.cancel} cancelled.`);
  const replace=e.target.closest('[data-replace]');if(replace){const o=snapshot.orders.find(o=>o.id===Number(replace.dataset.replace));if(!o)return;$('#replace-id').value=o.id;$('#replace-order-id').textContent=`#${o.id}`;$('#replace-price').value=(o.price/100).toFixed(2);$('#replace-quantity').value=o.remaining;$('#replace-dialog').showModal();}
  const sc=e.target.closest('[data-scenario]');if(sc){const id=Number(sc.dataset.scenario);newSession('scenario',id);$('#order-price').value='100.00';renderScenarios();toast(`${scenarios[id-1].title} ready. Advance one command at a time.`);}
});
$('#tree-canvas').addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-node-price]')){e.preventDefault();selectedLevel={price:Number(e.target.dataset.nodePrice),side:Number(e.target.dataset.nodeSide)};renderLab();}});
$$('[data-tree]').forEach(b=>b.addEventListener('click',()=>{treeSide=Number(b.dataset.tree);selectedLevel=null;$$('[data-tree]').forEach(x=>x.classList.toggle('active',x===b));if(snapshot)renderLab();}));
$('#close-replace').addEventListener('click',()=>$('#replace-dialog').close());
$('#replace-form').addEventListener('submit',e=>{e.preventDefault();const p=decimalPrice($('#replace-price').value),q=Number($('#replace-quantity').value);if(!p||!Number.isInteger(q)||q<1||q>1e6){toast('Enter a valid price and whole-share remaining quantity.',true);return;}const id=call('tc_replace',[Number($('#replace-id').value),p,q]);if(id!==false){$('#replace-dialog').close();toast(`Replacement accepted as order #${id}, with new priority.`);}});
$('#scenario-next').addEventListener('click',()=>{stopSimulation();call('tc_scenario_next');});
$('#scenario-play').addEventListener('click',()=>{if(scenarioTimer){stopScenario();return;}stopSimulation();$('#scenario-play').innerHTML=`${icon('pause')}Pause`;scenarioTimer=setInterval(()=>{const r=call('tc_scenario_next');if(r===0||r===false)stopScenario();},1350);});
$('#check-invariants').addEventListener('click',checkInvariants);$('#metrics-check').addEventListener('click',checkInvariants);
$('#run-benchmark').addEventListener('click',()=>{stopSimulation();stopScenario();const start=performance.now();const result=call('tc_simulate',[1000]);const total=performance.now()-start;const engineMs=durations[durations.length-1];if(result===false)return;lastBenchmark={ms:engineMs,rate:engineMs>0?1000000/engineMs:0};renderMetrics();toast(`1,000 C-generated commands processed. Engine ${engineMs.toFixed(2)} ms; update ${total.toFixed(2)} ms.`);});

navigate();
async function init(){try{
  const response=await fetch('/engine.wasm');if(!response.ok)throw Error(`C engine download failed (${response.status}).`);
  const {instance}=await WebAssembly.instantiate(await response.arrayBuffer(),{});engine=instance.exports;
  let saved;try{saved=JSON.parse(localStorage.getItem(key));}catch{/* A blocked or invalid storage entry starts a clean demo. */}
  if(saved&&validSession(saved))restore(saved);else newSession('market');
  if(engine.tc_check()!==1)throw Error('The C engine failed its startup invariant check.');
  $('#engine-status').textContent='C engine ready';$('#status-dot').classList.add('ready');$('#simulation-toggle').disabled=false;$('#submit-order').disabled=false;
  $('#order-price').value=(snapshot.stats.lastPrice/100).toFixed(2);updateValue();
}catch(error){$('#engine-status').textContent='Engine unavailable';$('#status-dot').style.background='#cf8072';toast(`${error.message} Reload the page or serve it over HTTP.`,true);$('#price-chart').innerHTML='<div class="chart-empty">The C engine could not load.<br>Reload this page using the website URL or the local C server.</div>';console.error(error);}}
init();
