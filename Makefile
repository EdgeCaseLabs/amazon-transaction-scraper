.PHONY: help setup build skill clean-skill

# Skill source lives in SKILL_DIR; the built zip goes to the repo root (gitignored).
SKILL_DIR := .claude/skills/amazon-ynab-correlator
SKILL_NAME := amazon-ynab-correlator
SKILL_ZIP := $(SKILL_NAME).zip

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Guided end-to-end setup (install, build, skill, config snippet)
	@bash scripts/setup.sh

build: ## Compile TypeScript to dist/
	pnpm run build

skill: clean-skill ## Build the correlator skill zip (repo root) for Claude Desktop upload
	zip -jX $(SKILL_ZIP) $(SKILL_DIR)/SKILL.md
	@echo "Built ./$(SKILL_ZIP)"

clean-skill: ## Remove the built skill zip
	rm -f $(SKILL_ZIP)
