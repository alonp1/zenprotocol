#!/usr/bin/env python3
"""Save everything the node build needs from the original project's infrastructure.

Writes into the output folder (default ./mirror-out):
  packages/*.nupkg        every package (all versions) of the zenprotocol MyGet feed + the zen packages of nuget.org
  npm/*.tgz               every version of @zen/zen-node (the released binaries) from the MyGet npm registry
  repos/<name>.bundle     git bundle (all branches and tags) of every repository of the zenprotocol GitHub organization
  MANIFEST.json           file, size and sha256 of everything above

Run by .github/workflows/mirror-upstream.yml (the hosted runners have internet access), which publishes the
folder as the 'upstream-mirror' release. Standard library only. Failures of single items are reported, not fatal;
the exit code is 1 when nothing at all could be fetched from a source.
"""
import hashlib, json, os, re, subprocess, sys, tarfile, urllib.request, urllib.parse, xml.etree.ElementTree as ET

OUT = sys.argv[1] if len(sys.argv) > 1 else 'mirror-out'
MYGET = 'https://www.myget.org/F/zenprotocol'
NUGET_ZEN = [('ZFStar', '0.0.26'), ('Zen.FSharp.Compiler.Service', '17.0.2'), ('ZFS-Tools', '0.0.24')]
ORG = 'zenprotocol'
problems = []


def get(url, binary=False, retries=3):
    req = urllib.request.Request(url, headers={'User-Agent': 'zp-community-mirror', **({'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN']} if 'api.github.com' in url and os.environ.get('GITHUB_TOKEN') else {})})
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read() if binary else r.read().decode()
        except Exception as e:
            err = e
    raise err


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.part'
    open(tmp, 'wb').write(data)
    os.replace(tmp, path)


def myget_packages():
    """(id, version) of every package version in the feed, via the OData v2 listing (paged)."""
    out, url = [], MYGET + "/api/v2/Packages()?$select=Id,Version&$top=100"
    ns = {'a': 'http://www.w3.org/2005/Atom', 'd': 'http://schemas.microsoft.com/ado/2007/08/dataservices', 'm': 'http://schemas.microsoft.com/ado/2007/08/dataservices/metadata'}
    while url:
        root = ET.fromstring(get(url))
        for e in root.findall('a:entry', ns):
            p = e.find('m:properties', ns)
            out.append((p.find('d:Id', ns).text, p.find('d:Version', ns).text))
        nxt = [l.get('href') for l in root.findall('a:link', ns) if l.get('rel') == 'next']
        url = nxt[0] if nxt else None
    return out


def packages():
    n = 0
    try:
        found = myget_packages()
        print(f'MyGet feed: {len(found)} package versions')
    except Exception as e:
        problems.append('myget listing: ' + str(e)); found = []
    for pid, ver in found:
        try:
            save(f'{OUT}/packages/{pid}.{ver}.nupkg', get(f'{MYGET}/api/v2/package/{urllib.parse.quote(pid)}/{ver}', True)); n += 1
        except Exception as e:
            problems.append(f'{pid} {ver}: {e}')
    for pid, ver in NUGET_ZEN:
        try:
            low = pid.lower()
            save(f'{OUT}/packages/{pid}.{ver}.nupkg', get(f'https://api.nuget.org/v3-flatcontainer/{low}/{ver}/{low}.{ver}.nupkg', True)); n += 1
        except Exception as e:
            problems.append(f'nuget.org {pid} {ver}: {e}')
    return n


def npm():
    n = 0
    try:
        meta = json.loads(get(MYGET + '/npm/@zen%2Fzen-node'))
        for ver, info in meta.get('versions', {}).items():
            try:
                save(f'{OUT}/npm/zen-zen-node-{ver}.tgz', get(info['dist']['tarball'], True)); n += 1
            except Exception as e:
                problems.append(f'npm {ver}: {e}')
    except Exception as e:
        problems.append('npm listing: ' + str(e))
    return n


def repos():
    n, page = 0, 1
    while True:
        try:
            batch = json.loads(get(f'https://api.github.com/orgs/{ORG}/repos?per_page=100&page={page}&type=all'))
        except Exception as e:
            problems.append('github listing: ' + str(e)); break
        if not batch: break
        for r in batch:
            name = r['name']; mdir = f'{OUT}/.git-mirrors/{name}.git'
            try:
                subprocess.run(['git', 'clone', '--mirror', '--quiet', r['clone_url'], mdir], check=True, timeout=1800)
                os.makedirs(f'{OUT}/repos', exist_ok=True)
                subprocess.run(['git', '-C', mdir, 'bundle', 'create', os.path.abspath(f'{OUT}/repos/{name}.bundle'), '--all'], check=True, timeout=1800)
                subprocess.run(['rm', '-rf', mdir]); n += 1
            except Exception as e:
                problems.append(f'repo {name}: {e}')
        page += 1
    return n


def manifest():
    files = []
    for root, _, names in os.walk(OUT):
        for f in sorted(names):
            if f == 'MANIFEST.json' or f.endswith('.part'): continue
            p = os.path.join(root, f)
            h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
            files.append({'file': os.path.relpath(p, OUT), 'bytes': os.path.getsize(p), 'sha256': h})
    json.dump({'files': files, 'problems': problems}, open(f'{OUT}/MANIFEST.json', 'w'), indent=1)


counts = {'packages': packages(), 'npm': npm(), 'repos': repos()}
manifest()
print(counts)
for p in problems: print('PROBLEM', p)
sys.exit(1 if not any(counts.values()) else 0)
