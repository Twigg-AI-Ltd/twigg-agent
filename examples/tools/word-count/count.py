# A minimal twigg-agent tool: arguments arrive as JSON on stdin, the result goes to stdout.
import json
import sys

args = json.load(sys.stdin)
text = args.get("text")
if not isinstance(text, str):
    print('"text" must be a string.')
    sys.exit(1)

print(json.dumps({"lines": len(text.splitlines()), "words": len(text.split()), "chars": len(text)}))
