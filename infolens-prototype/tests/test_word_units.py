import unittest
from word_units import WordSegmenter

class WordUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.segmenter=WordSegmenter()

    def test_recursive_term_and_ascii_acronym_are_complete(self):
        units=self.segmenter.units('递归神经网络 LSTM')
        self.assertEqual([u['text'] for u in units],['递归','神经网络','LSTM'])
        self.assertEqual(units[0],{'start':0,'end':2,'text':'递归'})

    def test_offsets_are_utf16_and_never_cut_combining_or_emoji_clusters(self):
        text='👩🏽‍💻 e\u0301 递归网络'
        units=self.segmenter.units(text)
        raw=text.encode('utf-16-le')
        self.assertTrue(any(u['text']=='递归' for u in units))
        for unit in units:
            self.assertEqual(raw[unit['start']*2:unit['end']*2].decode('utf-16-le'),unit['text'])
            self.assertNotIn(unit['text'],['e','\u0301'])

    def test_code_identifiers_keep_operators_and_line_boundaries_separate(self):
        units=self.segmenter.units('cached_result != x\n递归网络 + 3.14','code')
        self.assertEqual([u['text'] for u in units],['cached_result','递归网络','3.14'])

if __name__=='__main__':
    unittest.main()
