#!/usr/bin/make -f

.ONESHELL:
.SHELL := /usr/bin/bash

PORT ?= 8000
BUN ?= bunx

help: ## Show available commands
	@echo "Usage: make [command]\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' Makefile | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

css: ## Build tailwind CSS once
	@$(BUN) @tailwindcss/cli -i src/styles/input.css -o src/styles/library.css --minify

css-watch: ## Watch tailwind CSS
	@$(BUN) @tailwindcss/cli -i src/styles/input.css -o src/styles/library.css --watch

dev: css ## Start development server
	@echo "Serving on http://localhost:$(PORT)"
	@python3 -m http.server $(PORT)

stop: ## Stop development server
	@lsof -ti tcp:$(PORT) | xargs -r kill -9 || true

open: ## Open development server in browser
	@open http://localhost:$(PORT)
