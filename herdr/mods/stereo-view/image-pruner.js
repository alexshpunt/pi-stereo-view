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
