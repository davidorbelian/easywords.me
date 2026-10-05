.PHONY: dev build check test e2e image e2e-image

dev:
	npm run dev

build:
	npm run build

check:
	npm run lint
	npm run typecheck
	npm test

test: check build
	playwright test

image:
	docker build --platform linux/amd64 -t easywords .

e2e-image: image
	bash scripts/e2e-image.sh easywords
