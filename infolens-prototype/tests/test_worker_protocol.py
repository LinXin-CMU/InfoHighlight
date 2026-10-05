import queue
import time
import unittest
from worker_protocol import requests, check_cancelled, CancelledError


class Stream:
    def __init__(self): self.lines = queue.Queue()
    def __iter__(self): return self
    def __next__(self):
        line = self.lines.get()
        if line is None: raise StopIteration
        return line


class ResidentCancellationTests(unittest.TestCase):
    def test_cancel_during_processing_and_continue_with_same_stream(self):
        stream = Stream()
        stream.lines.put('{"id":1,"action":"score"}\n')
        work = requests(stream)
        request, cancelled = next(work)
        self.assertEqual(request['id'], 1)
        self.assertFalse(cancelled())
        stream.lines.put('{"id":1,"action":"cancel"}\n')
        deadline = time.monotonic() + 1
        while not cancelled() and time.monotonic() < deadline:
            time.sleep(.001)
        self.assertTrue(cancelled())
        stream.lines.put('{"id":2,"action":"score"}\n')
        request2, cancelled2 = next(work)
        self.assertTrue(cancelled())
        with self.assertRaises(CancelledError): check_cancelled(cancelled)
        self.assertEqual(request2['id'], 2)
        self.assertFalse(cancelled2())
        stream.lines.put(None)
        with self.assertRaises(StopIteration): next(work)


if __name__ == '__main__': unittest.main()
