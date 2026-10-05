import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('mica_worker', Path(__file__).parents[1] / 'mica_worker.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture(sentences, block_id='p1'):
    targets, position = [], 0
    for i, text in enumerate(sentences):
        end = position + len(text.encode('utf-16-le')) // 2
        targets.append(dict(id=f'{block_id}:s{i}', blockId=block_id, start=position, end=end, text=text))
        position = end
    return dict(id=block_id, text=''.join(sentences), kind='paragraph'), targets


class ParagraphScoringTests(unittest.TestCase):
    def test_natural_paragraph_context_stays_separate(self):
        a, at = fixture(['这是背景。', '不得忽略约束。'])
        b, bt = fixture(['Another paragraph.'], 'p2')
        chunks = m.plan_chunks([a, b], at + bt, len, 100)
        self.assertEqual(len(chunks), 2)
        rows = m.make_rows(chunks[0])
        self.assertEqual(rows[0]['state'], rows[1]['state'])
        self.assertEqual(rows[0]['state']['untrusted_paragraph']['text'], a['text'])
        self.assertNotIn(b['text'], str(rows))
        self.assertEqual([r['kind'] for r in rows], ['score', 'score'])
        self.assertEqual(len(rows[0]['candidates']), 5)

    def test_long_paragraph_splits_only_at_sentence_boundaries_with_utf16(self):
        block, targets = fixture(['😀 第一条限制。', '第二条不能丢失。', '第三条同样保留。'])
        chunks = m.plan_chunks([block], targets, len, 17)
        self.assertEqual([t for c in chunks for t in c['targets']], targets)
        self.assertEqual(''.join(c['text'] for c in chunks), block['text'])
        for c in chunks:
            self.assertEqual(c['text'], m.utf16_slice(block['text'], c['start'], c['end']))
        self.assertGreater(len(chunks), 1)

    def test_one_oversized_sentence_is_never_truncated(self):
        block, targets = fixture(['很长的一句话' * 100 + '。', '下一句。'])
        chunks = m.plan_chunks([block], targets, len, 64)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[0]['text'], targets[0]['text'])
        self.assertEqual(chunks[0]['targets'], targets[:1])

    def test_transport_ids_and_offsets_cannot_influence_prompt(self):
        a, at = fixture(['普通背景。', '关键限制。'], 'browser-1')
        b, bt = fixture(['普通背景。', '关键限制。'], 'pdf-15')
        first = m.make_rows(m.plan_chunks([a], at, len)[0])
        second = m.make_rows(m.plan_chunks([b], bt, len)[0])
        for x, y in zip(first, second):
            self.assertNotEqual(x['id'], y['id'])
            self.assertEqual({k:v for k,v in x.items() if k != 'id'}, {k:v for k,v in y.items() if k != 'id'})

    def test_rejects_misaligned_and_out_of_order_targets(self):
        block, targets = fixture(['😀 不得失配。', '下一句。'])
        for broken in ([dict(targets[0], text='假的'), targets[1]], [dict(targets[0], end=999)], list(reversed(targets))):
            with self.assertRaises(ValueError):
                m.plan_chunks([block], broken, len)

    def test_scores_are_expected_ordinals_not_cross_sentence_ranks(self):
        self.assertEqual(m.importance([0, 0, 0, 0, 1]), 100)
        self.assertEqual(m.importance([1, 0, 0, 0, 0]), 0)
        self.assertEqual(m.importance([0, 0, 0, .4, .6]), 90)
        for value in ([float('nan')] * 5, [.5] * 5, [-1, 0, 0, 1, 1], [1]):
            with self.assertRaises(ValueError):
                m.importance(value)

    def test_category_logits_validate_distribution_and_use_paragraph_context(self):
        block, targets = fixture(['这是背景。', '必须保留公式。'])
        chunk = m.plan_chunks([block], targets, len)[0]
        row = m.category_row(chunk, targets[1], 'paper')
        self.assertEqual(row['kind'], 'choice')
        self.assertIn(block['text'], str(row['state']))
        self.assertEqual(len(row['candidates']), 7)
        self.assertEqual(m.category_value([0, 0, 1, 0, 0, 0, 0]), 'constraint')
        for values in ([1], [.5] * 7, [float('nan')] * 7):
            with self.assertRaises(ValueError):
                m.category_value(values)


if __name__ == '__main__':
    unittest.main()
