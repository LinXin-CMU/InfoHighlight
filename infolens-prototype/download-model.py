"""One-time official model download; inference itself remains offline."""
import json, pathlib, sys
from huggingface_hub import snapshot_download
app=pathlib.Path(__file__).resolve().parent
semantic='--semantic' in sys.argv
args=[a for a in sys.argv[1:] if a!='--semantic']
manifest=json.loads((app/('semantic-model-manifest.json' if semantic else 'model-manifest.json')).read_text(encoding='utf-8'))
if len(args)!=1:raise SystemExit('Usage: python download-model.py [--semantic] <model-directory>')
destination=pathlib.Path(args[0]).resolve()
snapshot_download(repo_id=manifest['repo'],revision=manifest['revision'],allow_patterns=[item['name'] for item in manifest['files']],local_dir=str(destination))
(destination/'model-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print('Download complete. Run configure-local.mjs to verify every checksum and configure paths.')
