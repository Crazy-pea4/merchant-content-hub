import assert from 'node:assert/strict';
import test from 'node:test';
import { clipCues, removeInterval, timelineCues, timelineLength, type EditClip, type Timeline } from '../src/shared/video-edit';
import type { Asset } from '../src/shared/types';

const clip: EditClip = {id:'first',assetId:'red',start:30,end:120,volume:0.5};
const asset = {id:'red',segments:[
  {start:null,end:null,text:'untimed'},
  {start:1,end:4,text:'今天开门',words:[{text:'今天',start:1,end:2},{text:'开门',start:3,end:4,punctuation:'。'}]}
]} as Asset;

test('an interior deletion keeps both source ranges and repositions timed words after the splice',()=>{
  const clips=removeInterval(clip,60,90);
  const t: Timeline = {clips,aspect:'landscape',captions:true,voiceId:''};
  assert.deepEqual(clips.map(c=>[c.start,c.end,c.volume]),[[30,60,0.5],[90,120,0.5]]);
  assert.notEqual(clips[0].id,clips[1].id);
  assert.equal(timelineLength(t),60);
  assert.deepEqual(timelineCues(t,[asset]).map(s=>[s.text,s.start,s.end,s.words?.[0].start]),[['今天',0,1,0],['开门。',1,2,1]]);
  assert.deepEqual(clipCues(asset,clip)[0].words,asset.segments[1].words);
});

test('whole-clip and boundary deletions avoid zero-length shots',()=>{
  assert.deepEqual(removeInterval(clip,0,150),[]);
  assert.deepEqual(removeInterval(clip,0,60),[{...clip,start:60}]);
  assert.deepEqual(removeInterval(clip,90,150),[{...clip,end:90}]);
  assert.deepEqual(removeInterval(clip,0,30),[clip]);
});
