.PHONY: test check serve demo

test:
	python3 -m unittest discover -s tests -v
	node --test tests/model.test.mjs

check:
	python3 -B scripts/check_syntax.py
	node --check viewer/model.mjs
	node --check --input-type=module < viewer/app.js
	node --check viewer/theme-init.js

serve:
	python3 viewer/server.py --project examples/demo

demo:
	cd examples/demo && ./run.sh
