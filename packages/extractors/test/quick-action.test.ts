/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractQuickAction } from '../src/quick-action.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const NEW_CASE_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.2/quickActions/NewCase.quickAction-meta.xml';
const NEW_CASE_GOLDEN_PATH_REL =
  'tests/golden/extractor-quick-action/NewCase.json';
const QUICK_UPDATE_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.2/objects/Account/quickActions/Quick_Update.quickAction-meta.xml';
const QUICK_UPDATE_GOLDEN_PATH_REL =
  'tests/golden/extractor-quick-action/Quick_Update.json';
const CALL_ACTION_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.2/objects/Account/quickActions/Call_Action.quickAction-meta.xml';
const CALL_ACTION_GOLDEN_PATH_REL =
  'tests/golden/extractor-quick-action/Call_Action.json';

/**
 * Write a `.quickAction-meta.xml` file under a fresh temp directory that
 * mirrors the top-level DX layout (`<tmp>/quickActions/{file}`). Returns
 * the temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempTopLevelQuickAction = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-qa-'));
  const quickActionsDir = join(dir, 'quickActions');
  await mkdir(quickActionsDir, { recursive: true });
  const path = join(quickActionsDir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/**
 * Write a `.quickAction-meta.xml` file under a fresh temp directory that
 * mirrors the DX-nested layout
 * (`<tmp>/objects/{obj}/quickActions/{file}`). Returns the temp-dir root
 * (for cleanup) and the absolute file path.
 */
const writeTempNestedQuickAction = async (
  objectApiName: string,
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-qa-'));
  const nestedDir = join(dir, 'objects', objectApiName, 'quickActions');
  await mkdir(nestedDir, { recursive: true });
  const path = join(nestedDir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractQuickAction', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the NewCase fixture (global Create action)', async () => {
      // The extractor stores `sourcePath` verbatim. Because vitest's cwd
      // is the package directory and `process.chdir` is unsupported in
      // vitest's worker pool, we call the extractor with the absolute
      // path and patch the golden's `sourcePath` to match.
      const fixtureAbsPath = resolve(HARNESS_ROOT, NEW_CASE_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, NEW_CASE_GOLDEN_PATH_REL);

      const result = await extractQuickAction(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden output for the Quick_Update fixture (object-scoped Update action)', async () => {
      // Quick_Update is an Update action on Account — produces one
      // `parentOf` edge and no `references` edge.
      const fixtureAbsPath = resolve(HARNESS_ROOT, QUICK_UPDATE_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, QUICK_UPDATE_GOLDEN_PATH_REL);

      const result = await extractQuickAction(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden output for the Call_Action fixture (LightningComponent variant on Account)', async () => {
      // Call_Action is a LightningComponent action on Account —
      // produces both `parentOf` and `references` (to
      // `AuraDefinitionBundle:c:callPanel`).
      const fixtureAbsPath = resolve(HARNESS_ROOT, CALL_ACTION_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CALL_ACTION_GOLDEN_PATH_REL);

      const result = await extractQuickAction(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });
  });

  describe('path resolution', () => {
    it('resolves top-level dotted filenames into Object.Action canonical IDs', async () => {
      // Per QuickAction.md: a file at `quickActions/Account.LogCall.quickAction-meta.xml`
      // produces canonical ID `QuickAction:Account.LogCall`.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Log Call</label>
  <type>LogACall</type>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Account.LogCall.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('QuickAction:Account.LogCall');
        expect(node.apiName).toBe('Account.LogCall');
        expect(node.parentId).toBe('CustomObject:Account');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itHarness('resolves dotless top-level filenames as global actions (Global.{ActionName})', async () => {
      // Per QuickAction.md: a top-level filename without a dot is a
      // global action; the object name defaults to the literal
      // string `'Global'`.
      const fixtureAbsPath = resolve(HARNESS_ROOT, NEW_CASE_FIXTURE_PATH_REL);
      const result = await extractQuickAction(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.id).toBe('QuickAction:Global.NewCase');
      expect(node.parentId).toBeNull();
      expect(result.value.edges).toEqual([]);
    });

    it('resolves DX-nested layouts using the grandparent directory as the object name', async () => {
      // Per QuickAction.md: `.../objects/{Obj}/quickActions/{Action}.quickAction-meta.xml`
      // uses the grandparent directory as the object name and the
      // filename (minus suffix) as the action name.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Update</label>
  <type>Update</type>
</QuickAction>`;
      const { dir, path } = await writeTempNestedQuickAction(
        'Contact',
        'Quick_Update.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('QuickAction:Contact.Quick_Update');
        expect(node.parentId).toBe('CustomObject:Contact');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('parentOf edge', () => {
    itHarness('emits parentOf for object-scoped actions', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, QUICK_UPDATE_FIXTURE_PATH_REL);
      const result = await extractQuickAction(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const parentEdge = result.value.edges.find((e) => e.edgeType === 'parentOf');
      expect(parentEdge).toBeDefined();
      if (!parentEdge) return;
      expect(parentEdge.fromId).toBe('CustomObject:Account');
      expect(parentEdge.toId).toBe('QuickAction:Account.Quick_Update');
      expect(parentEdge.confidence).toBe('declared');
      expect(parentEdge.source).toBe('quick-action-extractor');
      expect(parentEdge.properties).toEqual({});
    });

    itHarness('does not emit parentOf for global actions', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, NEW_CASE_FIXTURE_PATH_REL);
      const result = await extractQuickAction(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const parentEdges = result.value.edges.filter(
        (e) => e.edgeType === 'parentOf',
      );
      expect(parentEdges).toEqual([]);
    });
  });

  describe('references edge', () => {
    itHarness('emits references to AuraDefinitionBundle for LightningComponent actions', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, CALL_ACTION_FIXTURE_PATH_REL);
      const result = await extractQuickAction(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const refsEdge = result.value.edges.find(
        (e) => e.edgeType === 'references',
      );
      expect(refsEdge).toBeDefined();
      if (!refsEdge) return;
      expect(refsEdge.toId).toBe('AuraDefinitionBundle:c:callPanel');
      expect(refsEdge.properties).toEqual({ targetKind: 'aura' });
    });

    it('emits references to LightningComponentBundle for LightningWebComponent actions', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>LWC Action</label>
  <type>LightningWebComponent</type>
  <lightningWebComponent>c:myLwc</lightningWebComponent>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.LwcAction.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const refsEdge = result.value.edges.find(
          (e) => e.edgeType === 'references',
        );
        expect(refsEdge).toBeDefined();
        if (!refsEdge) return;
        expect(refsEdge.toId).toBe('LightningComponentBundle:c:myLwc');
        expect(refsEdge.properties).toEqual({ targetKind: 'lwc' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits references to ApexPage for VisualforcePage actions', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>VF Action</label>
  <type>VisualforcePage</type>
  <page>MyVfPage</page>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.VfAction.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const refsEdge = result.value.edges.find(
          (e) => e.edgeType === 'references',
        );
        expect(refsEdge).toBeDefined();
        if (!refsEdge) return;
        expect(refsEdge.toId).toBe('ApexPage:MyVfPage');
        expect(refsEdge.properties).toEqual({ targetKind: 'page' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts a Flow quick action and references the launched Flow (B18)', async () => {
      // Flow-type quick actions were rejected as `invalid type: Flow`, dropping
      // them from the vault entirely. They now extract and surface the launched
      // flow via <flowDefinition>.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Run Flow</label>
  <type>Flow</type>
  <flowDefinition>My_Screen_Flow</flowDefinition>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.RunFlow.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties.actionType).toBe('Flow');
        const refsEdge = result.value.edges.find(
          (e) => e.edgeType === 'references',
        );
        expect(refsEdge).toBeDefined();
        if (!refsEdge) return;
        expect(refsEdge.toId).toBe('Flow:My_Screen_Flow');
        expect(refsEdge.properties).toEqual({ targetKind: 'flow' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itHarness('emits no references edge for Create/Update/LogACall/SendEmail/SocialPost', async () => {
      // Per QuickAction.md: only LightningComponent / LightningWebComponent /
      // VisualforcePage variants produce a `references` edge.
      const fixtureAbsPath = resolve(HARNESS_ROOT, QUICK_UPDATE_FIXTURE_PATH_REL);
      const result = await extractQuickAction(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const refsEdges = result.value.edges.filter(
        (e) => e.edgeType === 'references',
      );
      expect(refsEdges).toEqual([]);
    });

    it('emits no references edge when the target element is absent for an LWC action', async () => {
      // Edge case: an action declared as LightningComponent but with
      // no `<lightningComponent>` body — pathological but not an
      // error per the spec. No `references` edge emits.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Empty LWC</label>
  <type>LightningComponent</type>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.EmptyLwc.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const refsEdges = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refsEdges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('optional properties', () => {
    it('defaults missing optional fields to null', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Bare</label>
  <type>LogACall</type>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.Bare.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties).toEqual({
          label: 'Bare',
          actionType: 'LogACall',
          description: null,
          targetObject: null,
          lightningComponent: null,
          lightningWebComponent: null,
          page: null,
          flowDefinition: null,
          icon: null,
          height: null,
          width: null,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itHarness('parses height as an integer when present', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, CALL_ACTION_FIXTURE_PATH_REL);
      const result = await extractQuickAction(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.properties['height']).toBe(400);
      expect(node.properties['width']).toBe('80%');
    });

    it('ignores reserved/advanced elements (fields, canvas, etc.) without erroring', async () => {
      // Per QuickAction.md: advanced elements may appear; the
      // extractor must not error.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Advanced</label>
  <type>Create</type>
  <fields>
    <field>Subject</field>
  </fields>
  <successMessage>Done</successMessage>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.Advanced.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('standard actions (standardLabel)', () => {
    it('extracts a standard action that carries <standardLabel> instead of <label>', async () => {
      // Standard quick actions (e.g. Task.UpdateStatus with <type>Update</type>)
      // carry a <standardLabel> enum (ChangeStatus, Defer, ChangePriority, …)
      // that names a platform-provided label — they omit the custom <label>
      // entirely. 120 of 125 example.gov quickActions are this shape; the
      // extractor must accept them and use the standardLabel as the display
      // label, never erroring or emitting the literal string "undefined".
      const xml = `<?xml version="1.0"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <standardLabel>ChangeStatus</standardLabel>
  <type>Update</type>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Task.UpdateStatus_2.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.label).toBe('ChangeStatus');
        expect(node.properties['label']).toBe('ChangeStatus');
        expect(node.apiName).toBe('Task.UpdateStatus_2');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      // Use a path that has a `quickActions` parent so path resolution
      // succeeds first and the file-not-found check is what fires.
      const path = '/nonexistent/quickActions/Missing.quickAction-meta.xml';
      const result = await extractQuickAction(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.Bad.quickAction-meta.xml',
        '<?xml version="1.0"?><QuickAction><label>X</wrongClose></QuickAction>',
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <QuickAction>', async () => {
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.Wrong.quickAction-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <QuickAction> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when both <label> and <standardLabel> are missing', async () => {
      // A custom action with neither a <label> nor a <standardLabel> is
      // genuinely malformed — there is no display label to show.
      const xml = `<?xml version="1.0"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <type>Create</type>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.NoLabel.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <label> or <standardLabel>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <type> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>NoType</label>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.NoType.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <type>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <type> is outside the allowed set', async () => {
      const xml = `<?xml version="1.0"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>BadType</label>
  <type>Bogus</type>
</QuickAction>`;
      const { dir, path } = await writeTempTopLevelQuickAction(
        'Global.BadType.quickAction-meta.xml',
        xml,
      );
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid type: Bogus');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the path is not under a quickActions/ directory', async () => {
      // Per QuickAction.md: the parser only recognizes two layouts —
      // `objects/{Obj}/quickActions/` and `quickActions/`. A file at
      // any other location is `malformed-input`.
      const dir = await mkdtemp(join(tmpdir(), 'sf-intel-qa-'));
      const path = join(dir, 'Stray.quickAction-meta.xml');
      const xml = `<?xml version="1.0"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Stray</label>
  <type>Create</type>
</QuickAction>`;
      await writeFile(path, xml, 'utf-8');
      try {
        const result = await extractQuickAction(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'cannot resolve object/action from path',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
