"""Package the alpha plugin without development profiles, verifier or libraries."""
from pathlib import Path
import zipfile,hashlib,json
root=Path(__file__).resolve().parent
names=['manifest.json','bootstrap.js','core.js','infolens.js','icon48.png','icon96.png','README.md','UPSTREAM-LICENSE.txt','UPSTREAM-NOTICE.txt']
version=json.loads((root/'manifest.json').read_text(encoding='utf8'))['version']
target=root.parent/f'InfoLens-Zotero-v{version}.xpi'
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
    for name in names:z.write(root/name,name)
with zipfile.ZipFile(target) as z:assert z.testzip() is None and len(z.namelist())==len(names)
print(json.dumps({'file':target.name,'files':len(names),'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}))
