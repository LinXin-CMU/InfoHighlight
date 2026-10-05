"""CPU-only display word boundaries; never replace the language-model tokenizer."""
import logging
import regex
import jieba

POLICY = 'jieba-0.42.1-default-hmm-off/grapheme-safe-v1'

class WordSegmenter:
    def __init__(self):
        jieba.setLogLevel(logging.WARNING)
        self.tokenizer = jieba.Tokenizer()
        self.tokenizer.initialize()

    def units(self, text, kind='paragraph'):
        utf16 = [0]
        for char in text:
            utf16.append(utf16[-1] + (2 if ord(char) > 0xffff else 1))
        boundaries = {0, len(text)}
        for match in regex.finditer(r'\X', text):
            boundaries.add(match.start()); boundaries.add(match.end())
        if kind == 'code':
            parts = [(m.group(), m.start(), m.end()) for m in regex.finditer(r'[\p{L}_][\p{L}\p{N}_]*|\d+(?:\.\d+)*', text)]
        else:
            parts = self.tokenizer.tokenize(text, mode='default', HMM=False)
        result = []
        for value, start, end in parts:
            if start not in boundaries or end not in boundaries or len(regex.findall(r'\X', value)) < 2 or not regex.search(r'[\p{L}\p{N}]', value):
                continue
            result.append({'start': utf16[start], 'end': utf16[end], 'text': value})
        return result
