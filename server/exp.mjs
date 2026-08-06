import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ff from 'ffmpeg-static';
import Database from 'better-sqlite3';

const db = new Database('./data/app.db', { readonly: true });
const cap = db.prepare("SELECT * FROM captures WHERE meeting_code='ekd-kifs-saf'").get();
console.log('captura:', cap.id, '| inicio', cap.started_at, '| fim', cap.ended_at);
db.close();

const dir = join('data/captures', cap.id);
function pcm(p) {
  const r = spawnSync(ff, ['-hide_banner','-loglevel','error','-i',p,'-f','f32le','-ac','1','-ar','16000','pipe:1'], { maxBuffer: 5e8 });
  const b = r.stdout || Buffer.alloc(0);
  const a = new Float32Array(Math.floor(b.length/4));
  for (let i=0;i<a.length;i++) a[i]=b.readFloatLE(i*4);
  return a;
}
for (const track of ['mic','remote']) {
  const files = readdirSync(dir).filter(f=>new RegExp(`^${track}-\\d+\\.webm$`).test(f)).sort();
  if (!files.length) { console.log(`${track}: SEM PEDACOS`); continue; }
  const tmp = `exp-${track}.webm`;
  writeFileSync(tmp, Buffer.concat(files.map(f=>readFileSync(join(dir,f)))));
  const a = pcm(tmp);
  let soma=0, pico=0, comSom=0;
  for (const v of a) { const x=Math.abs(v); soma+=v*v; if(x>pico)pico=x; if(x>0.01)comSom++; }
  const rms = a.length ? Math.sqrt(soma/a.length) : 0;
  console.log(`${track.padEnd(7)}: ${files.length} pedacos | ${(a.length/16000).toFixed(1)}s | RMS=${rms.toFixed(5)} | pico=${pico.toFixed(3)} | ${(100*comSom/(a.length||1)).toFixed(1)}% com som`);
  rmSync(tmp,{force:true});
}
