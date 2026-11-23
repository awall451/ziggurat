# New project quickstart

From an idea to a team that has read your plan and proposed its first jobs. The details behind each step are
in [console/README.md](../console/README.md#creating-a-project-with-console_deploy1).

## Before you start (once)

- The console runs with `CONSOLE_DEPLOY=1` and has a deploy target (Settings → Deploy targets).
- Optional: a `claude-token` file in the console's config folder (one line from `claude setup-token`, mode
  600). With it, the deploy finishes without you. Without it, you sign the new VM in by hand once.

## 1. Plan what to build

Two ways, and you can combine them:

- **Plan with Claude.** Talk it through in a Claude session, then ask it to write a draft: one JSON document
  in the shape of [`console/docs/new-project.schema.json`](../console/docs/new-project.schema.json), holding
  the goal, your design document and the settings, and to post it to the console's `/api/drafts`. The draft
  shows up under **Drafts** on the New project page. Nothing is deployed.
- **Write it yourself.** Open **New project**, write the goal, and drop in your plan or design as Markdown
  files.

The goal is a few honest paragraphs: what it is, who it is for, and how you will know it is good. Put the
detail in the documents. The lead reads them before it plans.

## 2. Pick the team

| Team | For |
|---|---|
| **Standard** | Most projects: a lead, two tech leads, builders, scouts, a reviewer and QA |
| **Small** | Small tools and experiments: one tech lead on cheaper models, no QA |
| **Device** | Software for hardware the VM does not have: it is proven in an emulator, and you try it on the device from `docs/BENCH-TEST.md` |

No template picks a language. The team chooses its stack in its first planning cycle and writes its own
checks (`tools/check`). The gate holds that change until you approve it.

## 3. When it's ready

Leave **Start a planning cycle** on. Once the VM is ready and its gate is proven, the lead reads your goal
and documents, writes no code, and proposes at most N jobs (5 by default) on the **Planning** tab. The team
stays halted throughout.

## 4. Check, dry run, create

1. **Check** reads the team and your inputs without running anything.
2. **Dry run** settles the VM's id and address and changes nothing.
3. **Create project** (within 15 minutes of the dry run) builds the VM, proves it is isolated, installs the
   team, signs it in, proves the gate, and starts the planning cycle if you asked for one.

## 5. After the first plan

- **Planning tab:** read the proposals, talk them over in the chat, approve what should run, and run it now or
  set a time.
- **Inbox tab:** the first job is usually the team's real `tools/check`. Read the lead's explanation and the
  diff, then approve or decline. When the team asks for a system package or a domain, approving it adds the
  domain to the gateway and installs the package between cycles.
- **Controls tab:** **Resume** when you want the team to keep going on its own between your approved jobs.
  **Halt** stops it at any time.

## If it fails

- Install failed: run the `qm rollback <vmid> provisioned && qm start <vmid>` command the page shows, then
  "Retry the install".
- Anything else: the page shows how far the deploy got. Its inputs and logs stay in
  `console-data/deploys/<id>/`.
