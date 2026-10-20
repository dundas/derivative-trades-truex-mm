import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview, reviewInput } from '../scripts/equity-review-loop';

test('review records skipped terminal goals without spawning agents', async () => {
  const dir=mkdtempSync(join(tmpdir(),'equity-review-'));
  try {
    const ledger=join(dir,'ledger.json'); writeFileSync(ledger,JSON.stringify({status:'complete',tasks:[]}));
    await runReview({ledger,out:dir,pairingScript:'/unused',timeoutMs:1000,spawn:async()=>{throw new Error('Must not spawn');}});
    expect(JSON.parse(readFileSync(join(dir,'latest.json'),'utf8')).skipped).toBe(true);
  } finally { rmSync(dir,{recursive:true}); }
});
test('failed pairing cannot be recorded as successful progress', async () => {
  const dir=mkdtempSync(join(tmpdir(),'equity-review-'));
  try {
    const ledger=join(dir,'ledger.json'); writeFileSync(ledger,JSON.stringify({status:'active',tasks:[]}));
    await expect(runReview({ledger,out:dir,pairingScript:'/unused',timeoutMs:1000,
      spawn:async()=>({code:1,stdout:'',stderr:'provider unavailable'})})).rejects.toThrow('incomplete');
    expect(JSON.parse(readFileSync(join(dir,'latest.json'),'utf8')).passed).toBe(false);
  } finally { rmSync(dir,{recursive:true}); }
});
test('review counts task evidence without treating runtime as completion', () => {
  const result=reviewInput({status:'active',tasks:[{status:'complete'},{status:'blocked'}]}, {connected:true});
  expect(result.counts.complete).toBe(1); expect(result.counts.blocked).toBe(1);
  expect(()=>reviewInput({status:'active'})).toThrow();
});
