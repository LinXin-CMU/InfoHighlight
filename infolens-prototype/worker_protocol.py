"""Read cancellation while a resident model processes a bounded request."""
import json
import queue
import threading


class CancelledError(RuntimeError):
    pass


def check_cancelled(cancelled):
    if cancelled():
        raise CancelledError('Cancelled')


def requests(stream):
    inbox = queue.Queue()
    events = {}
    lock = threading.Lock()

    def read():
        try:
            for line in stream:
                try:
                    request = json.loads(line)
                    if not isinstance(request, dict):
                        continue
                except (ValueError, TypeError):
                    continue
                with lock:
                    if request.get('action') == 'cancel':
                        event = events.get(request.get('id'))
                        if event is not None:
                            event.set()
                        continue
                    event = threading.Event()
                    events[request.get('id')] = event
                inbox.put((request, event))
        finally:
            with lock:
                for event in events.values():
                    event.set()
            inbox.put(None)

    threading.Thread(target=read, daemon=True).start()
    while True:
        item = inbox.get()
        if item is None:
            return
        request, event = item
        try:
            yield request, event.is_set
        finally:
            with lock:
                if events.get(request.get('id')) is event:
                    events.pop(request.get('id'), None)
