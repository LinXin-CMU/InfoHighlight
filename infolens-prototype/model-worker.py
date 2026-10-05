"""Offline causal scoring worker. JSON-lines stdout; no model generation or network."""
import os, sys, json, math, time, pathlib
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')
sys.stdout.reconfigure(encoding='utf-8'); sys.stdin.reconfigure(encoding='utf-8')
import torch, regex
from transformers import AutoTokenizer, AutoModelForCausalLM
from worker_protocol import requests, check_cancelled, CancelledError
from word_units import WordSegmenter, POLICY as WORD_BOUNDARY_POLICY

WINDOW=1024; OVERLAP=256; STRIDE=WINDOW-OVERLAP
def emit(data): print(json.dumps(data,ensure_ascii=False,allow_nan=False),flush=True)
def utf16_index(text):
    result=[0]
    for c in text: result.append(result[-1]+(2 if ord(c)>0xffff else 1))
    return result

class Scorer:
    def __init__(self, directory):
        if not torch.cuda.is_available(): raise RuntimeError('CUDA is required; no automatic CPU fallback.')
        self.directory=pathlib.Path(directory)
        self.word_segmenter=WordSegmenter()
        self.manifest=json.loads((self.directory/'model-manifest.json').read_text(encoding='utf-8'))
        self.tokenizer=AutoTokenizer.from_pretrained(directory,local_files_only=True,trust_remote_code=False,use_fast=True)
        self.model=AutoModelForCausalLM.from_pretrained(directory,local_files_only=True,trust_remote_code=False,use_safetensors=True,torch_dtype=torch.bfloat16,attn_implementation='sdpa').to('cuda').eval()
        self.prefix=self.tokenizer.eos_token_id
        if self.prefix is None:raise RuntimeError('A fixed document-start sentinel is required.')
    def metadata(self):
        return {'repo':self.manifest['repo'],'revision':self.manifest['revision'],'dtype':'bfloat16','device':torch.cuda.get_device_name(0),'windowTokens':WINDOW,'overlapTokens':OVERLAP,'contextPolicy':'lf-blocks-double-newline-eos-prefix-sliding-v1','normalization':'fixed-18bit-16level-v1','torch':torch.__version__}
    def score(self, blocks, profile='general',partial=lambda *_:None,cancelled=lambda:False):
        started=time.perf_counter(); text='\n\n'.join(b['text'] for b in blocks)
        word_units={b['id']:self.word_segmenter.units(b['text'],b.get('kind','paragraph')) for b in blocks}
        encoded=self.tokenizer(text,add_special_tokens=False,return_offsets_mapping=True)
        ids=[self.prefix]+encoded['input_ids']; offsets=encoded['offset_mapping']
        if len(ids)>24000:raise ValueError('Token limit is 24000; input was not truncated.')
        torch.cuda.reset_peak_memory_stats(); nll=[]; cursor=1
        with torch.inference_mode():
            while cursor<len(ids):
                check_cancelled(cancelled)
                begin=max(0,cursor-OVERLAP);end=min(len(ids),cursor+STRIDE)
                batch=torch.tensor([ids[begin:end]],dtype=torch.long,device='cuda')
                output=self.model(batch,use_cache=False)
                logits=output.logits[0,cursor-begin-1:end-begin-1].float()
                targets=batch[0,cursor-begin:end-begin]
                values=torch.logsumexp(logits,dim=-1)-logits.gather(-1,targets.unsqueeze(-1)).squeeze(-1)
                nll.extend(values.cpu().tolist()); del output,logits,targets,batch,values
                cursor=end
                check_cancelled(cancelled)
                if cursor<len(ids):partial(self.project(blocks,text,offsets,nll,profile,started,False,word_units))
        if len(nll)!=len(offsets):raise RuntimeError('Scoring shift alignment failed.')
        torch.cuda.synchronize()
        result=self.project(blocks,text,offsets,nll,profile,started,True,word_units)
        partial(result)
        return result
    def project(self,blocks,text,offsets,nll,profile,started,complete,word_units=None):
        graphemes=[(m.start(),m.end()) for m in regex.finditer(r'\X',text)]
        starts={}; ends={}
        for lo,hi in graphemes:
            for cp in range(lo,hi): starts[cp]=lo;ends[cp+1]=hi
        raw=[]
        for i,((lo,hi),value) in enumerate(zip(offsets,nll)):
            if hi<=lo:continue
            raw.append({'start':starts.get(lo,lo),'end':ends.get(hi,hi),'nll':value,'tokenIndices':[i]})
        # Several byte/BPE tokens may describe the same Unicode grapheme. Merge only
        # overlapping snapped ranges and add log-probabilities; never split that grapheme.
        groups=[]
        for token in raw:
            if groups and token['start']<groups[-1]['end']:
                old=groups[-1];old['end']=max(old['end'],token['end']);old['nll']+=token['nll'];old['tokenIndices']+=token['tokenIndices']
            else:groups.append(dict(token))
        # An unfinished BPE window may stop inside a grapheme. Reveal only whole
        # sentences strictly before the next unscored token's snapped start.
        through=len(text) if complete else starts.get(offsets[len(nll)][0],offsets[len(nll)][0])
        result=[];position=0
        for block in blocks:
            block_end=position+len(block['text']);index=utf16_index(block['text']);candidates=[]
            for token in groups:
                lo=max(position,token['start']);hi=min(block_end,token['end'])
                if hi<=lo or not text[lo:hi].strip():continue
                start=index[lo-position];end=index[hi-position];bits=token['nll']/math.log(2)
                candidates.append({'start':start,'end':end,'text':text[lo:hi],'surprisalRaw':token['nll'],'surprisalBits':bits,'surprisalNormalized':min(1,max(0,bits/18)),'semantic':None,'category':'general','tokenIndices':token['tokenIndices'],'availableSignals':['surprisal'],'source':'local_base'})
            result.append({**block,'sentences':[],'candidates':candidates,'wordUnits':(word_units or {}).get(block['id'],[]),'wordBoundaryPolicy':WORD_BOUNDARY_POLICY,'scoredThrough':index[min(len(block['text']),max(0,through-position))]});position=block_end+2
        gpu={'name':torch.cuda.get_device_name(0),'allocatedMiB':round(torch.cuda.memory_allocated()/1048576,1),'peakAllocatedMiB':round(torch.cuda.max_memory_allocated()/1048576,1),'peakReservedMiB':round(torch.cuda.max_memory_reserved()/1048576,1),'totalMiB':round(torch.cuda.get_device_properties(0).total_memory/1048576,1)}
        return {'schemaVersion':1,'engineVersion':'causal-base-v1','source':'local_base','profile':profile,'modelConnected':True,'offsetEncoding':'utf16','normalizationVersion':'lf-v1','model':self.metadata(),'availableSignals':['surprisal'],'semanticConnected':False,'tokenCount':len(nll),'scoredTokenCount':len(nll),'processingMs':round((time.perf_counter()-started)*1000),'gpu':gpu,'blocks':result,'disclaimer':'真实本地 Base 原文概率；semantic 尚未接入。18 bit 为参考绘制刻度，不是准确率。'}

def gpu_metrics():
    return {'name':torch.cuda.get_device_name(0),'allocatedMiB':round(torch.cuda.memory_allocated()/1048576,1),'peakAllocatedMiB':round(torch.cuda.max_memory_allocated()/1048576,1),'peakReservedMiB':round(torch.cuda.max_memory_reserved()/1048576,1),'totalMiB':round(torch.cuda.get_device_properties(0).total_memory/1048576,1)}
def main():
    scorer=Scorer(sys.argv[1]);semantic=None;semantic_path=sys.argv[2] if len(sys.argv)>2 and sys.argv[2] else None
    translator=None;translation_path=sys.argv[3] if len(sys.argv)>3 and sys.argv[3] else None
    emit({'type':'ready','model':scorer.metadata(),'semanticConfigured':bool(semantic_path)})
    for request,cancelled in requests(sys.stdin):
        try:
            check_cancelled(cancelled)
            if request.get('action')=='warmup':
                if semantic_path and (request.get('semantic') or not translation_path):
                    from semantic_worker import SemanticScorer
                    if semantic is None:semantic=SemanticScorer(semantic_path)
                if translation_path:
                    from translation_worker import TranslationScorer
                    if translator is None:translator=TranslationScorer(translation_path)
                scorer.score([{'id':'warmup','text':'InfoLens is ready.'}],cancelled=cancelled)
                if translator:translator.translate([{'id':'warmup','text':'Hello.'}],'zh',cancelled=cancelled)
                check_cancelled(cancelled)
                emit({'id':request['id'],'result':{'model':scorer.metadata(),'semanticModelLoaded':semantic is not None,'translationModelLoaded':translator is not None,'translationModel':translator.metadata() if translator else None,'gpu':gpu_metrics()}})
                continue
            if request.get('action')=='translate':
                if not translation_path and not semantic_path:raise ValueError('Local translation model is not configured.')
                emit({'type':'progress','id':request['id'],'stage':'translation_loading' if translator is None else 'translating'})
                if translation_path:
                    from translation_worker import TranslationScorer
                    if translator is None:translator=TranslationScorer(translation_path)
                    engine=translator
                else:
                    from semantic_worker import SemanticScorer
                    if semantic is None:semantic=SemanticScorer(semantic_path)
                    engine=semantic
                progress=lambda done,total:emit({'type':'progress','id':request['id'],'stage':'translating','done':done,'total':total})
                result=engine.translate(request['blocks'],request.get('targetLanguage','zh'),progress, cancelled=cancelled)
                result.update({'source':'local_models','semanticModelLoaded':semantic is not None,'translationModelLoaded':translator is not None,'gpu':gpu_metrics(),'model':scorer.metadata()})
                emit({'id':request['id'],'result':result});continue
            if request.get('action')!='score':
                emit({'id':request.get('id'),'error':{'code':'unsupported_action','message':'Use score or translate.'}});continue
            emit({'type':'progress','id':request['id'],'stage':'density'})
            publish=lambda result:emit({'type':'partial','id':request['id'],'result':result})
            job_started=time.perf_counter();result=scorer.score(request['blocks'],request.get('profile','general'),publish,cancelled);density_ms=result['processingMs'];semantic_load_ms=0
            if semantic_path and request.get('semantic', True):
                emit({'type':'progress','id':request['id'],'stage':'semantic_loading' if semantic is None else 'semantic'})
                try:
                    from semantic_worker import SemanticScorer
                    if semantic is None:
                        load_started=time.perf_counter();semantic=SemanticScorer(semantic_path);semantic_load_ms=round((time.perf_counter()-load_started)*1000)
                    emit({'type':'progress','id':request['id'],'stage':'semantic'})
                    progress=lambda done,total:emit({'type':'progress','id':request['id'],'stage':'semantic','done':done,'total':total})
                    def sentence_ready(report):
                        result['semanticReport']=report
                        publish(result)
                    result['semanticReport']=semantic.score(request.get('sentences',[]),request.get('context',[]),request.get('profile','general'),progress,sentence_ready)
                except torch.cuda.OutOfMemoryError:
                    import gc
                    gc.collect();torch.cuda.empty_cache()
                    result['semanticReport']={'rows':[],'status':'unavailable','errors':['semantic_gpu_oom'],'model':semantic.metadata() if semantic else None}
                except Exception:
                    result['semanticReport']={'rows':[],'status':'unavailable','errors':['semantic_local_model_error'],'model':semantic.metadata() if semantic else None}
                result['semanticModelLoaded']=semantic is not None
                result['gpu']=gpu_metrics();result['processingMs']=round((time.perf_counter()-job_started)*1000);result['timings']={'surprisalMs':density_ms,'semanticLoadMs':semantic_load_ms,'semanticMs':result['semanticReport'].get('processingMs'),'totalScoringMs':result['processingMs']}
            result['semanticModelLoaded']=semantic is not None
            result.setdefault('timings',{'surprisalMs':density_ms,'semanticLoadMs':0,'semanticMs':0,'totalScoringMs':result['processingMs']})
            result['translationModelLoaded']=translator is not None
            if translator:result['translationModel']=translator.metadata()
            emit({'id':request['id'],'result':result})
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache();emit({'id':request.get('id') if request else None,'error':{'code':'gpu_oom','message':'GPU memory exhausted. Use a shorter document.'}})
        except CancelledError:
            emit({'id':request['id'],'error':{'code':'cancelled','message':'Cancelled'}})
        except Exception as error:
            emit({'id':request.get('id') if request else None,'error':{'code':'scoring_failed','message':str(error) if isinstance(error,(ValueError,RuntimeError)) else type(error).__name__}})
        finally:
            # Keep model weights, release transient PyTorch buffers for resident Mica.
            torch.cuda.empty_cache()
if __name__=='__main__':
    try:main()
    except Exception as error:emit({'type':'fatal','error':type(error).__name__+': '+str(error)});sys.exit(1)
