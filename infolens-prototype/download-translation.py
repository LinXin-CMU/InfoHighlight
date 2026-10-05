import urllib.request,json,pathlib,hashlib,concurrent.futures,math,datetime,time,sys
repo='tencent/HY-MT1.5-1.8B';revision='dbad03788f49709801014c95d481a514c272ca52'
root=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else pathlib.Path(__file__).resolve().parents[2]/'work'/'models'/'HY-MT1.5-1.8B'
root.mkdir(parents=True,exist_ok=True);parts=root/'download-parts';parts.mkdir(exist_ok=True)
def request(url,headers={}):return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'InfoLens-Local-Setup/0.5',**headers}),timeout=90)
with request(f'https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true') as r:metadata=json.load(r)
names={'config.json','generation_config.json','tokenizer.json','tokenizer_config.json','vocab.json','merges.txt','License.txt','README.md','chat_template.jinja','special_tokens_map.json'};files=[f for f in metadata['siblings'] if f['rfilename'] in names or f['rfilename'].endswith('.safetensors') or f['rfilename'].endswith('.safetensors.index.json')];records=[];tasks=[];chunk=16*1024*1024
for f in files:
    dest=root/f['rfilename'];expected=f.get('lfs',{}).get('sha256')
    if dest.exists() and dest.stat().st_size==f['size']:
        checksum=hashlib.file_digest(dest.open('rb'),'sha256').hexdigest()
        if not expected or checksum==expected:records.append({'name':f['rfilename'],'bytes':f['size'],'sha256':checksum});continue
    for i in range(math.ceil(f['size']/chunk)):tasks.append((f,i))
def fetch(task):
    f,i=task;begin=i*chunk;end=min(f['size'],(i+1)*chunk)-1;part=parts/(f['rfilename']+f'.{i:04}.part')
    if part.exists() and part.stat().st_size==end-begin+1:return end-begin+1
    for attempt in range(5):
        try:
            url=f'https://huggingface.co/{repo}/resolve/{revision}/{f["rfilename"]}?download=true&infolens_part={i}&attempt={attempt}'
            with request(url,{'Range':f'bytes={begin}-{end}'}) as r,part.open('wb') as out:
                if r.status!=206 or r.headers.get('Content-Range')!=f'bytes {begin}-{end}/{f["size"]}':raise RuntimeError('Unexpected content range')
                while data:=r.read(1024*1024):out.write(data)
            if part.stat().st_size!=end-begin+1:raise RuntimeError('Incomplete part')
            return end-begin+1
        except Exception:
            if attempt==4:raise
            time.sleep(min(8,2**attempt))
started=time.monotonic();last=started;done=0;bytes_done=0
with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
    for future in concurrent.futures.as_completed([pool.submit(fetch,t) for t in tasks]):
        bytes_done+=future.result();done+=1
        if time.monotonic()-last>15 or done==len(tasks):print(json.dumps({'parts':done,'total':len(tasks),'MiB':round(bytes_done/1048576),'aggregateMiBps':round(bytes_done/1048576/(time.monotonic()-started),1)}),flush=True);last=time.monotonic()
for f in files:
    if any(r['name']==f['rfilename'] for r in records):continue
    dest=root/f['rfilename'];temp=dest.with_suffix(dest.suffix+'.assembling');digest=hashlib.sha256()
    with temp.open('wb') as out:
        for i in range(math.ceil(f['size']/chunk)):
            with (parts/(f['rfilename']+f'.{i:04}.part')).open('rb') as part:
                while data:=part.read(1024*1024):out.write(data);digest.update(data)
    checksum=digest.hexdigest();expected=f.get('lfs',{}).get('sha256')
    if expected and checksum!=expected:raise RuntimeError('Official model SHA mismatch: '+f['rfilename'])
    if temp.stat().st_size!=f['size']:raise RuntimeError('Size mismatch')
    temp.replace(dest);records.append({'name':f['rfilename'],'bytes':f['size'],'sha256':checksum});print(json.dumps({'verified':f['rfilename'],'bytes':f['size']}),flush=True)
(root/'model-manifest.json').write_text(json.dumps({'repo':repo,'revision':revision,'downloadedOn':datetime.date.today().isoformat(),'files':sorted(records,key=lambda r:r['name'])},indent=2),encoding='utf-8');print('TRANSLATION_MODEL_READY',flush=True)

(pathlib.Path(__file__).resolve().parent/'translation-model-manifest.json').write_text((root/'model-manifest.json').read_text(encoding='utf-8'),encoding='utf-8')
