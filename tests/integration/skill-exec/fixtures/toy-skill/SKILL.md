---
name: toy
version: 0.1.0
description: A toy skill for integration testing
requiredCapabilities:
  - skill.exec:toy

sandbox:
  workdir: repo
  network: off
  secrets:
    - TOY_SECRET
  bins:
    - bash
    - sh
    - echo
    - ls
    - cat
    - mkdir
  shell: /bin/bash
  timeoutSeconds: 30
---

# Toy Skill

Test commands:

```bash
echo "hello from toy skill"
echo "secret is $TOY_SECRET"
ls /workspace
```
