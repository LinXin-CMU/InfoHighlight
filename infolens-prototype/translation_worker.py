"""Offline dedicated HY-MT translation. One bound source paragraph per generation."""
import json, pathlib, time, gc, re
from collections import Counter
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig, GenerationConfig, StoppingCriteria, StoppingCriteriaList
from worker_protocol import check_cancelled

class CancelGeneration(StoppingCriteria):
    def __init__(self, cancelled): self.cancelled = cancelled
    def __call__(self, input_ids, scores, **kwargs): return self.cancelled()

POLICY='hy-mt-math-paragraph-v3/nf4/greedy/2048/1024/formatted-retry/eos-math-required'
LANGUAGES={'zh':'中文','en':'英语','ja':'日语','ko':'韩语','fr':'法语','de':'德语','es':'西班牙语'}

def math_tokens(text):
    # PDF adapter wraps complete glyph runs in single-dollar atoms. Also protect
    # actual LaTeX supplied by clients; a currency amount without a close is text.
    tokens=re.findall(r'(?<![\\$])\$\$[\s\S]+?(?<!\\)\$\$(?!\$)|(?<![\\$])\$(?!\$)[^$\n]+?(?<!\\)\$(?!\$)|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]', text)
    return [token for token in tokens if not (token.startswith('$') and not token.startswith('$$') and token[1:-1]!=token[1:-1].strip())]

def terminology(source,language):
    if language!='zh' or not (re.search(r'\bIV[1-3]\b',source) or re.search(r'\b(?:SNPs?|Mendelian|instrumental variable)\b',source,re.I)):
        return ''
    # Explicit statistical context avoids exposure -> photographic exposure and
    # IV methods -> random-effects models. This is a bounded domain glossary.
    terms=[('exposure','暴露'),('outcome','结局'),('confounders','混杂因素'),('IV methods','工具变量方法'),('instrumental variable','工具变量'),('exclusion restriction','排除性限制'),('exchangeability','可交换性'),('relevance','相关性')]
    selected=[(a,b) for a,b in terms if re.search(r'\b'+re.escape(a)+r'\b',source,re.I)]
    return '参考下面的翻译：\n'+''.join(f'{a} 翻译成 {b}\n' for a,b in selected)+'\n' if selected else ''
def prompt(source,language,formatted=False):
    if language not in LANGUAGES:raise ValueError('Unsupported translation target.')
    if formatted:
        if re.search(r'</?(?:sn|source|target)(?:\s|>)',source):raise ValueError('translation_format_collision')
        tokens=set(math_tokens(source))
        for token in sorted(tokens,key=len,reverse=True):source=source.replace(token,'<sn>'+token+'</sn>')
        return terminology(source,language)+f'将以下<source></source>之间的文本翻译为{LANGUAGES[language]}，注意只需要输出翻译后的结果，不要额外解释，原文中的<sn></sn>标签表示标签内文本包含格式信息，需要在译文中相应的位置尽量保留该标签。输出格式为：<target>str</target>\n\n<source>{source}</source>'
    preserve='原样保留数学表达式及其分隔符，完整翻译括号中的说明和限定条件。' if math_tokens(source) else ''
    return terminology(source,language)+f'将以下文本翻译为{LANGUAGES[language]}，注意只需要输出翻译后的结果，不要额外解释。{preserve}\n\n{source}'

def validate_output(source,text,complete,language,formatted=False):
    if not complete:raise ValueError('translation_output_budget')
    text=text.strip()
    if formatted:
        wrapper=re.fullmatch(r'<target>\s*([\s\S]*?)\s*</target>',text)
        if wrapper:text=wrapper.group(1)
        text=re.sub(r'</?sn>', '', text)
        if re.search(r'</?(?:sn|source|target)(?:\s|>)',text):raise ValueError('invalid_translation_format')
    if not text or len(text)>6000:raise ValueError('invalid_translation_text')
    if language=='zh' and re.search('[A-Za-z]{3}',source) and not re.search('[\u3400-\u9fff]',text):raise ValueError('translation_target_missing')
    if Counter(math_tokens(source))!=Counter(math_tokens(text)):raise ValueError('translation_math_changed')
    return text

class TranslationScorer:
    def __init__(self,directory):
        self.manifest=json.loads((pathlib.Path(directory)/'model-manifest.json').read_text(encoding='utf-8'))
        self.tokenizer=AutoTokenizer.from_pretrained(directory,local_files_only=True,trust_remote_code=False,use_fast=True)
        gc.collect();torch.cuda.empty_cache()
        quant=BitsAndBytesConfig(load_in_4bit=True,bnb_4bit_quant_type='nf4',bnb_4bit_use_double_quant=True,bnb_4bit_compute_dtype=torch.bfloat16)
        self.model=AutoModelForCausalLM.from_pretrained(directory,local_files_only=True,trust_remote_code=False,use_safetensors=True,torch_dtype=torch.bfloat16,attn_implementation='sdpa',quantization_config=quant,device_map={'':0}).eval()
        self.generation=GenerationConfig.from_model_config(self.model.config)
        self.generation.max_new_tokens=1024;self.generation.do_sample=False;self.generation.repetition_penalty=1.05
        self.generation.pad_token_id=self.tokenizer.pad_token_id or self.tokenizer.eos_token_id
    def metadata(self):return {'repo':self.manifest['repo'],'revision':self.manifest['revision'],'quantization':'nf4-double','computeDtype':'bfloat16','device':'cuda','dedicated':True,'policy':POLICY}
    def translate(self,blocks,target_language='zh',progress=lambda *_:None,cancelled=lambda:False):
        if target_language not in LANGUAGES:raise ValueError('Unsupported translation target.')
        started=time.perf_counter();rows=[];failed=[];generated=0
        for index,block in enumerate(blocks):
            check_cancelled(cancelled)
            translated=None;reason=None
            try:
                tokens=math_tokens(block['text']);attempts=[True] if len(tokens)>=3 else [False,True] if tokens else [False]
                for formatted in attempts:
                    check_cancelled(cancelled)
                    inputs=self.tokenizer.apply_chat_template([{'role':'user','content':prompt(block['text'],target_language,formatted)}],tokenize=True,add_generation_prompt=False,return_tensors='pt',return_dict=True)
                    inputs.pop('token_type_ids',None)
                    if inputs.input_ids.shape[1]>2048:raise ValueError('translation_input_budget')
                    inputs=inputs.to('cuda');length=inputs.input_ids.shape[1]
                    with torch.inference_mode():output=self.model.generate(**inputs,generation_config=self.generation,use_model_defaults=False,do_sample=False,stopping_criteria=StoppingCriteriaList([CancelGeneration(cancelled)]))
                    if cancelled():
                        del output,inputs
                        check_cancelled(cancelled)
                    suffix=output[0,length:];generated+=len(suffix)
                    eos=self.generation.eos_token_id;stops=eos if isinstance(eos,list) else [eos]
                    decoded=self.tokenizer.decode(suffix,skip_special_tokens=True);complete=int(suffix[-1]) in stops
                    del output,suffix,inputs
                    try:translated=validate_output(block['text'],decoded,complete,target_language,formatted)
                    except ValueError as error:
                        if str(error)=='translation_math_changed' and not formatted and len(attempts)>1:continue
                        raise
                    break
            except (ValueError,TypeError,KeyError) as error:
                reason=str(error) if isinstance(error,ValueError) else 'invalid_translation_schema';failed.append(block['id'])
            rows.append({'id':block['id'],'source':block['text'],'translated':translated,'status':'ready' if translated else 'unavailable',**({'reason':reason} if reason else {})})
            progress(index+1,len(blocks))
        return {'schemaVersion':1,'kind':'translation','targetLanguage':target_language,'status':'ready' if not failed else 'partial' if len(failed)<len(rows) else 'unavailable','blocks':rows,'failedIds':failed,'translationModel':self.metadata(),'policy':POLICY,'processingMs':round((time.perf_counter()-started)*1000),'generatedTokens':generated,'tools':False}
