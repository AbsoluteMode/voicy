const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '../..');
const ts = require(root + '/client/node_modules/typescript');
const code = ts.transpileModule(fs.readFileSync(root + '/client/src/lib/voice.ts', 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; }
function harness(api) {
  const rooms = [];
  const settings = {bitrate:128, volumes:{}, inputDevice:'', outputDevice:'', echoCancellation:false, noiseSuppression:false, autoGainControl:false};
  class Room {
    constructor() {
      this.remoteParticipants = new Map(); this.canPlaybackAudio = true; this.events = new Map(); this.switches=[]; this.disconnected=false;
      this.localParticipant = {identity:'local', name:'local', isMicrophoneEnabled:false, setMicrophoneEnabled:async enabled => {this.localParticipant.isMicrophoneEnabled=enabled;}, getTrackPublication:()=>undefined};
      rooms.push(this);
    }
    on(e, fn) {this.events.set(e, fn); return this;}
    removeAllListeners() {this.events.clear();}
    async connect(url) {this.url=url;}
    async disconnect() {this.disconnected=true;}
    async switchActiveDevice(...args) {this.switches.push(args);}
  }
  const exports = {};
  vm.runInNewContext(code, {exports, require: name => {
    if(name==='react') return {useSyncExternalStore:()=>{}};
    if(name==='livekit-client') return {Room, RoomEvent:new Proxy({}, {get:(_,k)=>k}), Track:{Source:{Microphone:'microphone'},Kind:{Audio:'audio'}}, DisconnectReason:{}};
    if(name==='./settings') return {getSettings:()=>settings};
    if(name==='./tauri') return {api};
    throw Error(name);
  }, AudioContext:class {async close() {}}, console});
  return {voice:exports.voice, rooms, settings};
}
(async()=>{
  const pending=deferred();
  const a=harness(()=>pending.promise);
  const connecting=a.voice.connect('cancelled.example');
  await a.voice.disconnect();
  pending.resolve({url:'wss://cancelled.example',token:'synthetic'});
  await connecting;
  assert.equal(a.voice.getSnapshot().state,'connected');
  assert.equal(a.rooms[0].localParticipant.isMicrophoneEnabled,true);
  console.log('REPRODUCED: disconnect while token request is pending still connects and enables microphone');
  const pa=deferred(),pb=deferred();
  const b=harness(host=>host==='a.example'?pa.promise:pb.promise);
  const ca=b.voice.connect('a.example'),cb=b.voice.connect('b.example');
  pb.resolve({url:'wss://b.example',token:'synthetic'}); await cb;
  pa.resolve({url:'wss://a.example',token:'synthetic'}); await ca;
  assert.equal(b.rooms.filter(r=>!r.disconnected&&r.localParticipant.isMicrophoneEnabled).length,2);
  await b.voice.disconnect();
  assert.equal(b.rooms.filter(r=>!r.disconnected&&r.localParticipant.isMicrophoneEnabled).length,1);
  console.log('REPRODUCED: overlapping token requests leave an untracked room with microphone enabled after disconnect');
  const c=harness(async()=>({url:'wss://one.example',token:'synthetic'}));
  await c.voice.connect('one.example');
  await c.voice.setDeafened(true);
  await c.voice.setMicMuted(false);
  assert.equal(c.voice.getSnapshot().deafened,true);
  assert.equal(c.rooms[0].localParticipant.isMicrophoneEnabled,true);
  console.log('REPRODUCED: microphone can publish while deafen remains active');
  c.settings.outputDevice='headphones'; await c.voice.applyAudioSettings();
  c.settings.outputDevice=''; await c.voice.applyAudioSettings();
  assert.equal(c.rooms[0].switches.length,1);
  assert.equal(c.rooms[0].switches[0][1],'headphones');
  console.log('REPRODUCED: selecting default output never sends a device switch');
})().catch(e=>{console.error(e);process.exitCode=1;});
