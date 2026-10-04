// ELK's actual worker dispatcher installs self.onmessage. Importing elk.bundled
// inside a native worker would select its fake-worker environment instead.
import "elkjs/lib/elk-worker.js";
