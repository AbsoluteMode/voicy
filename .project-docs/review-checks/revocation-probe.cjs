const assert=require('node:assert/strict');
const {SignalResponse}=require(require('node:path').resolve(__dirname, '../../client/node_modules/@livekit/protocol'));
const base=process.env.PROBE_API;
const sockets=[];
async function api(path,method='GET',token,body) {
  const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const text=await res.text();return {status:res.status,body:text?JSON.parse(text):null};
}
function connect(token) {
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(process.env.PROBE_LK+'/rtc?protocol=15&sdk=js&version=2.22.3&auto_subscribe=0&access_token='+encodeURIComponent(token));
    sockets.push(ws);ws.binaryType='arraybuffer';
    const timer=setTimeout(()=>reject(Error('signalling timeout')),10000);
    ws.onmessage=e=>{const msg=SignalResponse.fromBinary(new Uint8Array(e.data));if(msg.message.case==='join'){clearTimeout(timer);resolve(ws);}};
    ws.onerror=()=>{clearTimeout(timer);reject(Error('signalling rejected'));};
  });
}
(async()=>{
  const owner=(await api('/api/join','POST',undefined,{code:process.env.PROBE_BOOTSTRAP,nickname:'Review owner'})).body;
  assert.equal(owner.member.role,'owner');
  const invite=(await api('/api/invites','POST',owner.token,{})).body;
  const member=(await api('/api/join','POST',undefined,{code:invite.link.split('/').pop(),nickname:'Review member'})).body;
  const credential=(await api('/api/token','POST',member.token)).body;
  await connect(credential.token);
  const kicked=await api('/api/members/'+member.member.id+'/kick','POST',owner.token);
  assert.equal(kicked.status,204);
  assert.equal((await api('/api/token','POST',member.token)).status,401);
  await connect(credential.token);
  console.log('REPRODUCED: after successful kick and HTTP 401, LiveKit v1.13 accepts the same pre-kick JWT and sends JoinResponse');
  assert.equal((await api('/api/server','DELETE',owner.token)).status,204);
  assert.equal((await api('/api/token','POST',owner.token)).status,410);
  await connect(credential.token);
  console.log('REPRODUCED: after server deletion and HTTP 410, the same JWT recreates the main room and receives JoinResponse');
  for(const ws of sockets)ws.close();
})().then(()=>setTimeout(()=>process.exit(0),50)).catch(e=>{console.error(e.message);process.exit(1);});
