import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservationRecorder, sessionBand, acquireOutputLock } from '../src/equities/recorder';
const result={quotes:[],reasons:['mapping_unverified']};
test('coverage excludes unhealthy samples, long gaps and restart downtime',()=>{
  const out=mkdtempSync(join(tmpdir(),'equity-observations-'));
  try {
    const r=new ObservationRecorder(out,['NVDA'],2500,'fixture');
    r.sample('NVDA',10000,true,result,{});r.sample('NVDA',11000,true,result,{});
    r.sample('NVDA',21000,true,result,{});r.sample('NVDA',22000,false,result,{});
    r.save(22000,{},24);
    const r2=new ObservationRecorder(out,['NVDA'],2500,'fixture');
    r2.sample('NVDA',30000,true,result,{});r2.sample('NVDA',31000,true,result,{});
    const state=r2.save(31000,{},24);
    expect(state.coverage.NVDA.healthyMs).toBe(2000);expect(state.coverage.NVDA.eligibleMs).toBe(0);
    expect(state.coverage.NVDA.gapMs).toBe(19000);expect(state.observationHoursComplete).toBe(false);
    expect(state.pilotReady).toBe(false);
    expect(readdirSync(out).filter(x=>x.endsWith('.jsonl')).length).toBe(2);
    expect(JSON.parse(readFileSync(join(out,'status.json'),'utf8')).runs).toBe(2);
    expect(()=>new ObservationRecorder(out,['NVDA'],2500,'different')).toThrow('different configuration');
  } finally {rmSync(out,{recursive:true});}
});
test('New York time bands handle DST and weekend without claiming holiday coverage',()=>{
  expect(sessionBand(Date.parse('2026-10-20T13:35:00Z'))).toBe('open_window');
  expect(sessionBand(Date.parse('2026-12-01T14:35:00Z'))).toBe('open_window');
  expect(sessionBand(Date.parse('2026-10-20T19:50:00Z'))).toBe('close_window');
  expect(sessionBand(Date.parse('2026-10-21T02:00:00Z'))).toBe('overnight');
  expect(sessionBand(Date.parse('2026-10-24T14:00:00Z'))).toBe('weekend');
});
test('shutdown time never overwrites actual sample time or loses restart gaps',()=>{
  const out=mkdtempSync(join(tmpdir(),'equity-shutdown-'));
  try {
    const r=new ObservationRecorder(out,['NVDA'],2500,'fixture');
    r.sample('NVDA',10000,true,result,{});r.sample('NVDA',11000,true,result,{});
    expect(r.save(20000,{},24,true).lastSampleAt).toBe(11000);
    const r2=new ObservationRecorder(out,['NVDA'],2500,'fixture');r2.sample('NVDA',30000,true,result,{});
    const c=r2.save(30000,{},24).coverage.NVDA;
    expect(c.healthyMs).toBe(1000);expect(c.gapMs).toBe(19000);expect(c.maxUnhealthyMs).toBe(19000);
  } finally {rmSync(out,{recursive:true});}
});
test('output lock rejects live owners and serializes recovery attempts',()=>{
  const out=mkdtempSync(join(tmpdir(),'equity-lock-'));
  try {
    const release=acquireOutputLock(out);
    expect(()=>acquireOutputLock(out)).toThrow('already running');release();
    mkdirSync(join(out,'collector.acquire'));
    expect(()=>acquireOutputLock(out)).toThrow('Another collector');
    rmSync(join(out,'collector.acquire'),{recursive:true});
    const release2=acquireOutputLock(out);
    writeFileSync(join(out,'collector.lock'),JSON.stringify({pid:process.pid,token:'different-owner'}));
    expect(()=>release2()).toThrow('ownership changed');
  } finally {rmSync(out,{recursive:true});}
});
