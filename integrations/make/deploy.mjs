import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { definition, message, root } from './app.mjs';

const segment = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(message('error.files'));
  return encodeURIComponent(value);
};
const sectionNames = {
  communication: 'api',
  params: 'parameters',
  staticParams: 'parameters',
  mappableParams: 'expect',
  requiredScope: 'scope',
  interface: 'interface',
  samples: 'samples',
  scope: 'scope',
  attach: 'attach',
  detach: 'detach',
  code: 'code',
};
export async function loadApp() {
  const generated = await definition();
  for (const [path, expected] of generated) {
    if ((await readFile(new URL(path, root), 'utf8')) !== expected) throw new Error(message('error.files'));
  }
  const app = JSON.parse(await readFile(new URL('app.json', root), 'utf8'));
  const project = JSON.parse(await readFile(new URL('makecomapp.json', root), 'utf8'));
  segment(app.name);
  if (!Number.isSafeInteger(app.version) || app.version < 1 || project.origins.length)
    throw new Error(message('error.files'));
  const files = new Map();
  const read = async (path) => {
    const url = new URL(path, root);
    const actual = await realpath(url);
    if (!actual.startsWith(fileURLToPath(root))) throw new Error(message('error.files'));
    if (files.has(path)) return files.get(path);
    const content = await readFile(url, 'utf8');
    if (path.endsWith('.json')) JSON.parse(content);
    if (path.endsWith('.js')) {
      if (content.length > 5000) throw new Error(message('error.files'));
      new vm.Script(content, { filename: path });
    }
    files.set(path, content);
    return content;
  };
  for (const path of Object.values(project.generalCodeFiles)) if (path) await read(path);
  for (const [kind, components] of Object.entries(project.components)) {
    for (const [name, component] of Object.entries(components)) {
      segment(name);
      if (component.connection && !project.components.connection[component.connection])
        throw new Error(message('error.files'));
      if (component.webhook && !project.components.webhook[component.webhook])
        throw new Error(message('error.files'));
      for (const [section, path] of Object.entries(component.codeFiles)) {
        if (
          !sectionNames[section] ||
          !path ||
          !['connection', 'function', 'rpc', 'webhook', 'module'].includes(kind)
        )
          throw new Error(message('error.files'));
        await read(path);
      }
    }
  }
  return { app, project, files };
}

export function deploymentPlan({ app, project }) {
  const plan = [app.name];
  for (const section of Object.keys(project.generalCodeFiles)) plan.push(`${app.name}/${section}`);
  for (const [kind, components] of Object.entries(project.components)) {
    for (const [name, component] of Object.entries(components)) {
      plan.push(`${app.name}/${kind}/${name}`);
      for (const section of Object.keys(component.codeFiles))
        plan.push(`${app.name}/${kind}/${name}/${sectionNames[section]}`);
    }
  }
  return plan;
}

export async function deploy({
  check = false,
  env = process.env,
  fetch: request = globalThis.fetch,
  log = console.log,
} = {}) {
  const loaded = await loadApp();
  const { app, project, files } = loaded;
  const status = (name, state) => log(`${name} ${app.version} ${message(`status.${state}`)}`);
  if (check) {
    for (const name of deploymentPlan(loaded)) status(name, 'planned');
    status(app.name, 'valid');
    return;
  }
  const token = env.MAKE_API_TOKEN;
  const zone = env.MAKE_ZONE;
  if (!token || !/^(?:us[12]|eu[12])\.make\.com$/.test(zone || '') || /[\r\n]/.test(token))
    throw new Error(message('error.environment'));
  const call = async (method, path, body, mime = 'application/json') => {
    let response;
    try {
      response = await request(`https://${zone}/api/v2${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(40_000),
        headers: {
          Authorization: `Token ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': mime }),
        },
        ...(body === undefined ? {} : { body: mime === 'application/json' ? JSON.stringify(body) : body }),
      });
    } catch {
      throw new Error(message('error.deployment'));
    }
    if (!response.ok) throw new Error(message('error.deployment'));
    // Error bodies can echo request credentials, so they never enter logs or thrown messages.
    try {
      return response.status === 204 ? {} : await response.json();
    } catch {
      throw new Error(message('error.deployment'));
    }
  };
  const unique = (items) => {
    if (items.length > 1) throw new Error(message('error.ambiguous'));
    return items[0];
  };
  const list = async (path, key) => {
    const response = await call('GET', path);
    if (!Array.isArray(response[key])) throw new Error(message('error.deployment'));
    return response[key];
  };
  const apps = await list('/sdk/apps?opensource=false', 'apps');
  let remote = unique(apps.filter((entry) => entry.name === app.name && entry.version === app.version));
  if (!remote) {
    if (apps.some((entry) => entry.name === app.name)) throw new Error(message('error.deployment'));
    remote = (await call('POST', '/sdk/apps', { app })).app;
    if (!remote || remote.name !== app.name || remote.version !== app.version)
      throw new Error(message('error.deployment'));
    status(app.name, 'created');
  } else {
    await call('PATCH', `/sdk/apps/${segment(remote.name)}/${app.version}`, {
      label: app.label,
      description: app.description,
      theme: app.theme,
      language: app.language,
    });
    status(app.name, 'updated');
  }
  const appPath = `/sdk/apps/${segment(remote.name)}`;
  const versionPath = `${appPath}/${app.version}`;
  const mappings = { connection: {}, webhook: {} };
  const jsonFile = (path) => JSON.parse(files.get(path));
  const sendSections = async (kind, name, component, target) => {
    for (const [section, path] of Object.entries(component.codeFiles)) {
      const javascript = path.endsWith('.js');
      await call(
        'PUT',
        `${target}/${sectionNames[section]}`,
        javascript ? files.get(path) : jsonFile(path),
        javascript ? 'application/javascript' : 'application/json',
      );
      status(`${app.name}/${kind}/${name}/${sectionNames[section]}`, 'updated');
    }
  };
  const functionPath = `${versionPath}/functions`;
  const existingFunctions = await list(functionPath, 'appFunctions');
  for (const name of Object.keys(project.components.function)) {
    if (!unique(existingFunctions.filter((entry) => entry.name === name))) {
      const created = await call('POST', functionPath, { name });
      if (created.appFunction?.name !== name) throw new Error(message('error.deployment'));
    }
  }
  for (const [name, component] of Object.entries(project.components.function)) {
    await sendSections('function', name, component, `${functionPath}/${segment(name)}`);
  }
  // Connections and webhooks have account-assigned names and live outside an app version.
  for (const [kind, listKey, createKey] of [
    ['connection', 'appConnections', 'appConnection'],
    ['webhook', 'appWebhooks', 'appWebhook'],
  ]) {
    const existing = await list(`${appPath}/${kind}s`, listKey);
    for (const [name, component] of Object.entries(project.components[kind])) {
      let found = unique(existing.filter((entry) => entry.name === name || entry.label === component.label));
      const connection = component.connection ? mappings.connection[component.connection] : undefined;
      const metadata = { label: component.label, ...(connection ? { connection } : {}) };
      const type = kind === 'connection' ? component.connectionType : component.webhookType;
      if (found) {
        if (
          found.type !== type ||
          found.alias_to ||
          (found.app_version != null && Number(found.app_version) !== app.version)
        )
          throw new Error(message('error.deployment'));
        await call('PATCH', `/sdk/apps/${kind}s/${segment(found.name)}`, metadata);
      } else {
        found = (await call('POST', `${appPath}/${kind}s`, { ...metadata, type }))[createKey];
      }
      if (!found) throw new Error(message('error.deployment'));
      mappings[kind][name] = found.name;
      await sendSections(kind, name, component, `/sdk/apps/${kind}s/${segment(found.name)}`);
    }
  }
  for (const section of ['base', 'common', 'groups', 'readme']) {
    const path = project.generalCodeFiles[section];
    await call(
      section === 'base' ? 'POST' : 'PUT',
      `${versionPath}/${section}`,
      section === 'readme' ? files.get(path) : jsonFile(path),
      section === 'readme' ? 'text/markdown' : 'application/json',
    );
    status(`${app.name}/${section}`, 'updated');
  }
  const types = { action: 4, search: 9, instant_trigger: 10, universal: 12 };
  for (const [kind, key, createdKey] of [
    ['rpc', 'appRpcs', 'appRpc'],
    ['module', 'appModules', 'appModule'],
  ]) {
    const target = `${versionPath}/${kind}s`;
    const existing = await list(target, key);
    for (const [name, component] of Object.entries(project.components[kind])) {
      const metadata = {
        ...(component.label ? { label: component.label } : {}),
        ...(component.description ? { description: component.description } : {}),
        ...(component.connection ? { connection: mappings.connection[component.connection] } : {}),
      };
      const found = unique(existing.filter((entry) => entry.name === name));
      if (!found) {
        const created = await call('POST', target, {
          name,
          ...metadata,
          ...(kind === 'module'
            ? {
                typeId: types[component.moduleType],
                moduleInitMode: 'blank',
                ...(component.moduleType === 'universal' ? { subtype: 'Universal' } : {}),
                ...(component.webhook ? { webhook: mappings.webhook[component.webhook] } : {}),
              }
            : {}),
        });
        if (created[createdKey]?.name !== name) throw new Error(message('error.deployment'));
      } else {
        if (kind === 'module' && found.typeId !== types[component.moduleType])
          throw new Error(message('error.deployment'));
        if (kind === 'module' && component.webhook) {
          const detail = (await call('GET', `${target}/${segment(name)}`)).appModule;
          if (detail?.webhook !== mappings.webhook[component.webhook])
            throw new Error(message('error.deployment'));
        }
        await call('PATCH', `${target}/${segment(name)}`, metadata);
      }
      await sendSections(kind, name, component, `${target}/${segment(name)}`);
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== '--check'))
      throw new Error(message('error.arguments'));
    await deploy({ check: args[0] === '--check' });
  } catch {
    console.error(`riosoma 1 ${message('status.failed')}`);
    process.exitCode = 1;
  }
}
