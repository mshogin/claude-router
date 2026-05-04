# claude-router - install / uninstall / status
#
# Quick start (idempotent, can be re-run):
#   make install
#
# This installs:
#   - npm dependency:    @musistudio/claude-code-router  (the underlying router)
#   - go binary:         promptlint                      (prompt feature extractor)
#   - config dir:        ~/.claude-router/  (with default models.yaml on first run)
#   - sandbox dir:       ~/sandbox/llm-clean/
#   - launcher symlink:  ~/bin/claude-router -> bin/run.sh
#   - shell symlink:     ~/.claude-router/claude-router.zsh -> shell/claude-router.zsh
#   - zshrc block:       sources the shell file
#
# Other targets:
#   make deps         install just the external tools
#   make uninstall    remove symlinks + zshrc block (keeps config)
#   make status       show installation + live service state

.PHONY: install deps uninstall status help

REPO_DIR    := $(abspath $(CURDIR))
CONFIG_DIR  := $(HOME)/.claude-router
BIN_DIR     := $(HOME)/bin
SANDBOX_DIR := $(HOME)/sandbox/llm-clean
ZSHRC       := $(HOME)/.zshrc
ZSH_SOURCE  := $(CONFIG_DIR)/claude-router.zsh
SHELL_FILE  := $(REPO_DIR)/shell/claude-router.zsh
LAUNCHER    := $(BIN_DIR)/claude-router
RUN_SCRIPT  := $(REPO_DIR)/bin/run.sh
EXAMPLE_YAML := $(REPO_DIR)/examples/models.example.yaml
USER_YAML   := $(CONFIG_DIR)/models.yaml

PROMPTLINT_PKG := github.com/mshogin/promptlint/cmd/promptlint@latest
CCR_NPM_PKG    := @musistudio/claude-code-router

MARKER_BEGIN := \# >>> claude-router >>>
MARKER_END   := \# <<< claude-router <<<

help:
	@echo "make install    - full install (deps + config + symlinks + zshrc)"
	@echo "make deps       - install external tools only (ccr, promptlint)"
	@echo "make uninstall  - remove symlinks and zshrc block"
	@echo "make status     - show installation state and live ports"

deps:
	@echo "==> Installing dependencies"
	@command -v node >/dev/null 2>&1 || { echo "ERROR: node 18+ required (https://nodejs.org)"; exit 1; }
	@command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required"; exit 1; }
	@if ! command -v ccr >/dev/null 2>&1; then \
		echo "    npm install -g $(CCR_NPM_PKG)"; \
		npm install -g $(CCR_NPM_PKG); \
	else \
		echo "    [ok] ccr installed"; \
	fi
	@if ! command -v promptlint >/dev/null 2>&1; then \
		if command -v go >/dev/null 2>&1; then \
			echo "    go install $(PROMPTLINT_PKG)"; \
			go install $(PROMPTLINT_PKG); \
		else \
			echo "    [warn] Go not installed - skipping promptlint."; \
			echo "           Router will use fallback_model for every request."; \
			echo "           Install Go and run 'go install $(PROMPTLINT_PKG)' to enable scoring."; \
		fi \
	else \
		echo "    [ok] promptlint installed"; \
	fi
	@python3 -c "import yaml" 2>/dev/null || { \
		echo "    pip install pyyaml"; \
		python3 -m pip install --quiet pyyaml || pip3 install --quiet pyyaml; \
	}

install: deps
	@echo "==> Installing claude-router"
	@# Shell detection - the integration is zsh-only (uses zsh-specific
	@# parameter expansion). On bash we still write the source line into
	@# ~/.zshrc so a future `chsh -s /bin/zsh` picks it up, but warn loudly.
	@case "$${SHELL:-}" in \
		*/zsh) : ;; \
		*) echo "    [warn] Default shell is $${SHELL:-unknown} - claude-router shell helpers are zsh-only."; \
		   echo "           Source line will still be added to ~/.zshrc. To use the helpers,"; \
		   echo "           switch shell: chsh -s $$(command -v zsh)" ;; \
	esac
	@mkdir -p "$(CONFIG_DIR)"
	@mkdir -p "$(BIN_DIR)"
	@mkdir -p "$(SANDBOX_DIR)"

	@# 1) models.yaml on first run.
	@if [ ! -f "$(USER_YAML)" ]; then \
		echo "    creating default $(USER_YAML)"; \
		cp "$(EXAMPLE_YAML)" "$(USER_YAML)"; \
		echo ""; \
		echo "    NEXT: edit $(USER_YAML) and put your real api_key values."; \
		echo ""; \
	else \
		echo "    keeping existing $(USER_YAML)"; \
	fi

	@# 2) Symlinks.
	@if [ -L "$(LAUNCHER)" ] || [ ! -e "$(LAUNCHER)" ]; then \
		ln -sf "$(RUN_SCRIPT)" "$(LAUNCHER)"; \
		echo "    symlink $(LAUNCHER) -> $(RUN_SCRIPT)"; \
	else \
		echo "    SKIP $(LAUNCHER) - exists and is not a symlink"; \
	fi
	@ln -sf "$(SHELL_FILE)" "$(ZSH_SOURCE)"
	@echo "    symlink $(ZSH_SOURCE) -> $(SHELL_FILE)"

	@# 3) zshrc block (idempotent).
	@if [ ! -f "$(ZSHRC)" ]; then touch "$(ZSHRC)"; fi
	@if grep -qF "$(MARKER_BEGIN)" "$(ZSHRC)"; then \
		echo "    updating zshrc block in $(ZSHRC)"; \
		awk -v b="$(MARKER_BEGIN)" -v e="$(MARKER_END)" \
		    'BEGIN{skip=0} \
		     index($$0,b){skip=1; next} \
		     index($$0,e){skip=0; next} \
		     !skip{print}' "$(ZSHRC)" > "$(ZSHRC).tmp" && mv "$(ZSHRC).tmp" "$(ZSHRC)"; \
	else \
		echo "    adding zshrc block to $(ZSHRC)"; \
	fi
	@printf '\n%s\n[ -f "%s" ] && source "%s"\n%s\n' \
		'$(MARKER_BEGIN)' \
		"$(ZSH_SOURCE)" "$(ZSH_SOURCE)" \
		'$(MARKER_END)' >> "$(ZSHRC)"

	@echo ""
	@echo "Done. Final steps:"
	@echo "  1. Edit $(USER_YAML) - put real api_keys"
	@echo "  2. Reload shell:  source $(ZSHRC)"
	@echo "  3. Start stack:   claude-router-reload"

uninstall:
	@echo "==> Uninstalling claude-router (config dir is preserved)"
	@if [ -L "$(LAUNCHER)" ]; then rm -f "$(LAUNCHER)" && echo "    rm $(LAUNCHER)"; fi
	@if [ -L "$(ZSH_SOURCE)" ]; then rm -f "$(ZSH_SOURCE)" && echo "    rm $(ZSH_SOURCE)"; fi
	@if [ -f "$(ZSHRC)" ] && grep -qF "$(MARKER_BEGIN)" "$(ZSHRC)"; then \
		echo "    removing zshrc block from $(ZSHRC)"; \
		awk -v b="$(MARKER_BEGIN)" -v e="$(MARKER_END)" \
		    'BEGIN{skip=0} \
		     index($$0,b){skip=1; next} \
		     index($$0,e){skip=0; next} \
		     !skip{print}' "$(ZSHRC)" > "$(ZSHRC).tmp" && mv "$(ZSHRC).tmp" "$(ZSHRC)"; \
	fi
	@echo ""
	@echo "Removed symlinks and zshrc block. Config remains at $(CONFIG_DIR)."

status:
	@echo "Repo:        $(REPO_DIR)"
	@echo "Config dir:  $(CONFIG_DIR) $$( [ -d $(CONFIG_DIR) ] && echo '[exists]' || echo '[missing]' )"
	@echo "User YAML:   $(USER_YAML) $$( [ -f $(USER_YAML) ] && echo '[exists]' || echo '[missing]' )"
	@echo "Sandbox:     $(SANDBOX_DIR) $$( [ -d $(SANDBOX_DIR) ] && echo '[exists]' || echo '[missing]' )"
	@echo "Launcher:    $(LAUNCHER) $$( [ -L $(LAUNCHER) ] && echo '-> '$$(readlink $(LAUNCHER)) || echo '[missing]' )"
	@echo "ZSH source:  $(ZSH_SOURCE) $$( [ -L $(ZSH_SOURCE) ] && echo '-> '$$(readlink $(ZSH_SOURCE)) || echo '[missing]' )"
	@if [ -f "$(ZSHRC)" ] && grep -qF "$(MARKER_BEGIN)" "$(ZSHRC)"; then \
		echo "ZSHRC block: present"; \
	else \
		echo "ZSHRC block: missing"; \
	fi
	@echo ""
	@echo "External tools:"
	@command -v ccr        >/dev/null 2>&1 && echo "  ccr        [ok]" || echo "  ccr        [missing - run 'make deps']"
	@command -v promptlint >/dev/null 2>&1 && echo "  promptlint [ok]" || echo "  promptlint [missing - run 'make deps']"
	@command -v claude     >/dev/null 2>&1 && echo "  claude     [ok]" || echo "  claude     [missing - install Claude Code]"
	@echo ""
	@echo "Live ports:"
	@for p in 8080:promptlint 3456:ccr 3457:footer-proxy; do \
		port=$${p%%:*}; label=$${p##*:}; \
		if lsof -ti :$$port >/dev/null 2>&1; then \
			echo "  :$$port $$label  [up]"; \
		else \
			echo "  :$$port $$label  [down]"; \
		fi; \
	done
