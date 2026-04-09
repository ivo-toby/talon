import { describe, it, expect } from 'vitest';
import { scanSkillBody } from '../../../src/cli/commands/install-skill-scanner.js';

describe('scanSkillBody', () => {
  it('extracts bins from bash fences with multiple commands', () => {
    const markdown = `
# Git Worktree Skill

Create a worktree:
\`\`\`bash
git worktree add -b feat/foo ../foo
npm install
npx vitest run
\`\`\`

Push changes:
\`\`\`bash
git push origin feat/foo
gh pr create --title "Feature" --body "Description"
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins).toEqual(new Set(['git', 'npm', 'npx', 'vitest', 'gh']));
    expect(result.envs).toEqual(new Set());
    expect(result.urls).toEqual(new Set());
  });

  it('extracts bins, envs, and urls from shell with exports and curl', () => {
    const markdown = `
\`\`\`bash
export CONTENTFUL_MANAGEMENT_TOKEN=$CMA_TOKEN
npx contentful space migration create --name add-author
curl https://api.contentful.com/spaces/$SPACE_ID/entries
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins).toEqual(new Set(['npx', 'contentful', 'curl']));
    expect(result.envs).toContain('CMA_TOKEN');
    expect(result.envs).toContain('SPACE_ID');
    expect(result.envs).toContain('CONTENTFUL_MANAGEMENT_TOKEN');
    expect(result.urls.size).toBe(1);
    const url = [...result.urls][0];
    expect(url).toMatch(/^https:\/\/api\.contentful\.com/);
  });

  it('extracts envs and urls from javascript fences', () => {
    const markdown = `
\`\`\`javascript
const token = process.env.API_TOKEN;
const url = "https://api.example.com/v1/data";
fetch(url, { headers: { Authorization: process.env['SECRET_KEY'] } });
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins).toEqual(new Set());
    expect(result.envs).toEqual(new Set(['API_TOKEN', 'SECRET_KEY']));
    expect(result.urls).toEqual(new Set(['https://api.example.com/v1/data']));
  });

  it('extracts envs from python fences', () => {
    const markdown = `
\`\`\`python
import os
token = os.environ.get("GITHUB_TOKEN")
api_key = os.getenv('OPENAI_KEY')
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins).toEqual(new Set());
    expect(result.envs).toEqual(new Set(['GITHUB_TOKEN', 'OPENAI_KEY']));
    expect(result.urls).toEqual(new Set());
  });

  it('ignores non-executable fence languages', () => {
    const markdown = `
\`\`\`json
{"key": "value"}
\`\`\`

\`\`\`yaml
name: test
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins.size).toBe(0);
    expect(result.envs.size).toBe(0);
    expect(result.urls.size).toBe(0);
  });

  it('returns empty sets when no fences are present', () => {
    const markdown = `
# Just a heading

Some plain text without any code fences.
`;
    const result = scanSkillBody(markdown);
    expect(result.bins.size).toBe(0);
    expect(result.envs.size).toBe(0);
    expect(result.urls.size).toBe(0);
  });

  it('merges results from mixed fences (bash + python)', () => {
    const markdown = `
\`\`\`bash
curl https://api.example.com/data
\`\`\`

\`\`\`python
import os
key = os.getenv('API_KEY')
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins).toEqual(new Set(['curl']));
    expect(result.envs).toEqual(new Set(['API_KEY']));
    expect(result.urls).toEqual(new Set(['https://api.example.com/data']));
  });

  it('excludes built-in shell variables', () => {
    const markdown = `
\`\`\`bash
echo $HOME $PATH $PWD $USER $SHELL
echo $MY_CUSTOM_VAR
echo $0 $1 $? $# $$
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.envs).toEqual(new Set(['MY_CUSTOM_VAR']));
    // HOME, PATH, PWD, USER, SHELL, 0, 1, ?, #, $ should all be excluded
    expect(result.envs).not.toContain('HOME');
    expect(result.envs).not.toContain('PATH');
    expect(result.envs).not.toContain('PWD');
  });

  it('handles pipes and logical operators', () => {
    const markdown = `
\`\`\`bash
cat file.txt | grep pattern | wc -l
git status && npm test || echo "failed"
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins).toContain('cat');
    expect(result.bins).toContain('grep');
    expect(result.bins).toContain('wc');
    expect(result.bins).toContain('git');
    expect(result.bins).toContain('npm');
    expect(result.bins).toContain('echo');
  });

  it('handles sudo wrapper — extracts both sudo and the next binary', () => {
    const markdown = `
\`\`\`bash
sudo apt install -y curl
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins).toContain('sudo');
    expect(result.bins).toContain('apt');
  });

  it('skips comment lines and empty lines in shell blocks', () => {
    const markdown = `
\`\`\`bash
# This is a comment

git status
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins).toEqual(new Set(['git']));
  });

  it('skips bare variable assignment lines', () => {
    const markdown = `
\`\`\`bash
FOO=bar
MY_VAR="hello"
git status
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins).toEqual(new Set(['git']));
    // FOO and MY_VAR should not appear as bins
    expect(result.bins).not.toContain('FOO=bar');
    expect(result.bins).not.toContain('MY_VAR="hello"');
  });

  it('handles process.env["FOO"] with double quotes in JS', () => {
    const markdown = `
\`\`\`javascript
const x = process.env["DB_HOST"];
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.envs).toContain('DB_HOST');
  });

  it('handles os.environ bracket access in python', () => {
    const markdown = `
\`\`\`python
import os
secret = os.environ['SECRET']
other = os.environ["OTHER_SECRET"]
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.envs).toEqual(new Set(['SECRET', 'OTHER_SECRET']));
  });

  it('supports sh, shell, and zsh fence tags', () => {
    const markdown = `
\`\`\`sh
ls -la
\`\`\`

\`\`\`shell
pwd
\`\`\`

\`\`\`zsh
brew install jq
\`\`\`
`;
    const result = scanSkillBody(markdown);
    expect(result.bins).toContain('ls');
    expect(result.bins).toContain('pwd');
    expect(result.bins).toContain('brew');
  });
});
