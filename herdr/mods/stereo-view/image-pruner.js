// This fixed program runs as a direct child of Herdr App. Each mod runtime gets
// its own randomly named directory, tagged with the parent App PID. A reused PID
// can keep old files around but can never cause a new owner's files to be deleted:
// the random suffix makes a new directory distinct from any directory being pruned.
// Legacy flat-cache files are deliberately untouched: an older App may use them.
export const IMAGE_CACHE_INIT = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.argv[1],pid=process.ppid;
if(!Number.isSafeInteger(pid)||pid<=0)process.exit(2);
fs.mkdirSync(root,{recursive:true});
const name='owner-'+pid+'-'+crypto.randomBytes(16).toString('hex');
fs.mkdirSync(path.join(root,name));
for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  const match=/^owner-([1-9][0-9]*)-[0-9a-f]{32}$/.exec(entry.name);
  if(!match||!entry.isDirectory()||entry.name===name)continue;
  const owner=Number(match[1]);if(!Number.isSafeInteger(owner)||owner<=0)continue;
  let dead=false;try{process.kill(owner,0)}catch(e){dead=e.code==='ESRCH'}
  if(dead){try{fs.rmSync(path.join(root,entry.name),{recursive:true,force:true})}catch{}}
}
process.stdout.write(name);`;

/**
 * Initialize an isolated cache once. A failed initialization is never replaced
 * with the unsafe shared directory; a later image request may retry it.
 * @param {() => Promise<{code:number, stdout:string}>} run
 * @returns {() => Promise<string>}
 */
export function createImageCache(run) {
  let pending;
  return () => pending ??= Promise.resolve().then(run).then(result => {
    const name = result.stdout?.trim();
    if (result.code !== 0 || !/^owner-[1-9][0-9]*-[0-9a-f]{32}$/.test(name ?? "")) throw new Error("Image cache initialization failed");
    return name;
  }).catch(error => { pending = undefined; throw error; });
}

/** A shared, byte-bounded cache. Pinned images stay until they leave all visible views.
 * @param {number} limit
 * @param {(path: string) => Promise<void>} remove
 * @param {(id: string) => boolean} pinned
 */
export function createBoundedImageStore(limit, remove, pinned) {
  const entries = new Map(), loading = new Map(), removing = new Map();
  let size = 0, pruning;
  const get = id => {
    const entry = entries.get(id);
    if (!entry) return undefined;
    entries.delete(id); entries.set(id, entry);
    return entry.path;
  };
  const prune = () => {
    if (pruning) return pruning;
    pruning = (async () => {
      while (size > limit) {
        const candidate = [...entries].find(([id]) => !pinned(id));
        if (!candidate) break;
        const [id, entry] = candidate;
        entries.delete(id); size -= entry.size;
        const operation = Promise.resolve().then(() => remove(entry.path));
        removing.set(id, operation);
        try { await operation; }
        catch (error) { entries.set(id, entry); size += entry.size; throw error; }
        finally { removing.delete(id); }
      }
    })().finally(() => { pruning = undefined; });
    return pruning;
  };
  const load = (id, write) => {
    const cached = get(id);
    if (cached) return Promise.resolve(cached);
    if (loading.has(id)) return loading.get(id);
    const operation = (async () => {
      await removing.get(id);
      const again = get(id);
      if (again) return again;
      const entry = await write();
      entries.set(id, entry); size += entry.size;
      await prune();
      return entry.path;
    })().finally(() => { loading.delete(id); });
    loading.set(id, operation);
    return operation;
  };
  return { get, load, prune };
}
