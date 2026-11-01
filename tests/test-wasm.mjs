import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const binary=process.platform==='win32'?'build/tradecore.exe':'build/tradecore';
if(!existsSync(root+binary))throw Error('Build the native CLI before running WASM parity tests.');
const module=await WebAssembly.compile(readFileSync(root+'web/engine.wasm'));
assert.equal(WebAssembly.Module.imports(module).length,0,'The C engine must not depend on browser or libc imports.');
const e=(await WebAssembly.instantiate(module,{})).exports;
const decode=ptr=>{const b=new Uint8Array(e.memory.buffer,ptr);return new TextDecoder().decode(b.subarray(0,b.indexOf(0)));};
function wasmScript(text){e.tc_reset(42);for(const line of text.split(/\r?\n/)){const [cmd,a,b,c]=line.trim().split(/\s+/);if(!cmd||cmd.startsWith('#'))continue;
    const p=x=>Math.round(Number(x)*100);
    if(cmd==='buy'||cmd==='sell')e.tc_submit(cmd==='buy'?0:1,p(a),Number(b),0);
    else if(cmd==='cancel')e.tc_cancel(Number(a));
    else if(cmd==='replace')e.tc_replace(Number(a),p(b),Number(c));
    else if(cmd==='scenario')e.tc_scenario({fifo:1,partial:2,rotation:3,hash:4}[a]);
    else if(cmd==='next')e.tc_scenario_next();
    else if(cmd==='market')e.tc_seed_market();
    else throw Error(`Unsupported test replay command ${cmd}`);
  }assert.equal(e.tc_check(),1);return JSON.parse(decode(e.tc_snapshot()));}
for(const name of ['partial-fill','cancel-replace','rotations','sample-market']){
  const file=`demos/${name}.tcx`,native=spawnSync(root+binary,['--script',file,'--json'],{cwd:root,encoding:'utf8'});
  assert.equal(native.status,0,native.stderr);const a=JSON.parse(native.stdout),b=wasmScript(readFileSync(root+file,'utf8'));
  delete a.stats.reservedBytes;delete b.stats.reservedBytes;
  assert.deepEqual(b,a,`${name}: native and WebAssembly snapshots must match exactly`);
  assert.ok(b.candles.every(c=>c.high>=c.open&&c.high>=c.close&&c.low<=c.open&&c.low<=c.close&&c.volume>0));
  console.log(`PASS native / WASM parity: ${name}`);
}
e.tc_scenario(4);e.tc_scenario_next();e.tc_scenario_next();
const collision=JSON.parse(decode(e.tc_snapshot())).hash.find(b=>b.ids.includes(1));
assert.ok(collision.ids.includes(2049),'IDs 1 and 2049 must share a real hash bucket');
e.tc_scenario_next();assert.equal(e.tc_check(),1);
console.log('PASS real hash collision, bounded C JSON, native / WASM parity, candle invariants, and zero host imports.');
