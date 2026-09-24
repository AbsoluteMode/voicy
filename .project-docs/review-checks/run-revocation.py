import json,os,secrets,socket,subprocess,tempfile,time,urllib.request
from pathlib import Path
base=Path(__file__).resolve().parent
root=base.parent.parent
image='livekit/livekit-server@sha256:6fd3b7088874c4d119160dd688798dfec852bc014786d392caad15f6f63912a3'
container=None
server=None
with tempfile.TemporaryDirectory(prefix='voicy-review-runtime-') as runtime:
    runtime=Path(runtime)
    key='review'+secrets.token_hex(6); secret=secrets.token_hex(32); bootstrap=secrets.token_hex(24)
    cfg=runtime/'livekit.yaml'
    cfg.write_text(f'port: 7880\nbind_addresses: ["0.0.0.0"]\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  {key}: {secret}\nroom:\n  auto_create: true\n  max_participants: 10\n')
    cfg.chmod(0o600)
    try:
        container=subprocess.check_output(['docker','run','-d','--rm','-p','127.0.0.1::7880','-v',f'{cfg}:/etc/livekit.yaml:ro',image,'--config','/etc/livekit.yaml'],text=True).strip()
        data=json.loads(subprocess.check_output(['docker','inspect',container],text=True))[0]
        port=data['NetworkSettings']['Ports']['7880/tcp'][0]['HostPort']
        lk='http://127.0.0.1:'+port
        for _ in range(100):
            try:
                urllib.request.urlopen(lk,timeout=1); break
            except Exception: time.sleep(.1)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0)); server_port=sock.getsockname()[1]
        env=os.environ.copy();env.update(VOICY_BIND=f'127.0.0.1:{server_port}',VOICY_DB=str(runtime/'db.sqlite'),VOICY_PUBLIC_HOST='review.invalid',VOICY_BOOTSTRAP_CODE=bootstrap,LIVEKIT_API_URL=lk,LIVEKIT_API_KEY=key,LIVEKIT_API_SECRET=secret)
        with (runtime/'server.log').open('w') as log:
            server=subprocess.Popen([str(root/'server'/'target'/'debug'/('voicy-server.exe' if os.name=='nt' else 'voicy-server'))],env=env,stdout=log,stderr=log)
            api=f'http://127.0.0.1:{server_port}'
            for _ in range(100):
                try:
                    urllib.request.urlopen(api+'/api/info',timeout=1); break
                except Exception: time.sleep(.1)
            test_env=os.environ.copy();test_env.update(PROBE_API=api,PROBE_LK=lk.replace('http:','ws:'),PROBE_BOOTSTRAP=bootstrap)
            result=subprocess.run(['node',str(base/'revocation-probe.cjs')],env=test_env,timeout=35)
            if result.returncode: raise RuntimeError('revocation probe failed')
    finally:
        if server:
            server.terminate()
            try:server.wait(timeout=5)
            except subprocess.TimeoutExpired:server.kill();server.wait()
        if container:subprocess.run(['docker','stop',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
