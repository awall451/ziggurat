# Ziggurat Console. Build from the repository root:
#   docker compose -f console/docker-compose.yml --env-file <your env file> up -d --build
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY console/package.json console/package-lock.json ./
RUN npm ci
COPY console/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# ansible-core runs the sandbox playbooks when a project is created from the
# console (only with CONSOLE_DEPLOY=1). It comes from pip, in its own venv:
# Debian's package is too old for the Python on current Ubuntu VMs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client rsync git tini ca-certificates python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/ansible \
 && /opt/ansible/bin/pip install --no-cache-dir 'ansible-core~=2.18.0'
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY themes/ ./themes/
# What a deploy runs or copies into a new VM, at the same paths as in the repository.
COPY sandbox/ ./sandbox/
COPY kit/ ./kit/
COPY examples/ ./examples/
COPY tools/ ./tools/
COPY console/ansible/ ./console/ansible/
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ZIGGURAT_THEMES_DIR=/app/themes \
    CONSOLE_REPO_DIR=/app \
    PATH=/opt/ansible/bin:$PATH \
    BODY_SIZE_LIMIT=26214400
# A playbook that does not parse must fail the build, not a deploy.
RUN ANSIBLE_CONFIG=/app/console/ansible/ansible.cfg ANSIBLE_HOME=/tmp/ansible-check \
    ansible-playbook -i 'pve,' --syntax-check sandbox/proxmox/playbooks/create-agent-vm.yml \
 && ANSIBLE_CONFIG=/app/console/ansible/ansible.cfg ANSIBLE_HOME=/tmp/ansible-check \
    ansible-playbook -i 'agent_vm,' --syntax-check sandbox/install/install-team.yml \
 && rm -rf /tmp/ansible-check
# Runs as the image's unprivileged user (uid 1000). Files it pulls land in the
# mounted folders with that owner, so use a host user with the same uid.
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "build"]
