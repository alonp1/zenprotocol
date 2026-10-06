#!/usr/bin/env python3
"""One-off converter: legacy .fsproj (net47, paket hint-path references) -> SDK-style .fsproj.

Keeps every item group and every paket <Choose>/<Import> block verbatim, so the exact
same assemblies are referenced. Only the legacy MSBuild boilerplate is replaced.
Shared settings live in src/Directory.Build.props.
"""
import re
import sys
from pathlib import Path

DROP_IMPORT = re.compile(
    r'^\s*<Import Project="[^"]*(MSBuildExtensionsPath|MSBuildToolsPath|FSharpTargetsPath|FSharp\.Compiler\.Tools)[^"]*"[^>]*/>\s*\n',
    re.M)
PROP_GROUP = re.compile(r'^\s*<PropertyGroup( Condition="[^"]*")?>\n(.*?)^\s*</PropertyGroup>\s*\n', re.M | re.S)


def prop(body, name):
    m = re.search(rf'<{name}>(.*?)</{name}>', body, re.S)
    return m.group(1).strip() if m else None


def convert(path: Path):
    text = path.read_text(encoding='utf-8-sig')
    if 'Sdk="Microsoft.NET.Sdk"' in text:
        print(f'skip (already SDK): {path}')
        return

    glob_props, cfg = {}, {}
    def take(m):
        cond, body = m.group(1) or '', m.group(2)
        if not cond:
            if prop(body, 'MinimumVisualStudioVersion') and not prop(body, 'AssemblyName'):
                return ''
            if prop(body, 'AssemblyName') or prop(body, 'ProjectGuid'):
                for k in ('OutputType', 'AssemblyName', 'RootNamespace'):
                    v = prop(body, k)
                    if v:
                        glob_props[k] = v
                return ''
            return m.group(0)
        c = re.search(r"'(Debug|Release)\|", cond)
        if c:
            cfg[c.group(1)] = {k: prop(body, k) for k in
                               ('Tailcalls', 'DefineConstants', 'OtherFlags', 'PlatformTarget', 'WarningLevel')}
            return ''
        return m.group(0)

    text = PROP_GROUP.sub(take, text)
    text = DROP_IMPORT.sub('', text)

    header = ['  <PropertyGroup>']
    for k in ('OutputType', 'AssemblyName', 'RootNamespace'):
        if k in glob_props:
            header.append(f'    <{k}>{glob_props[k]}</{k}>')
    dbg = cfg.get('Debug', {})
    for k in ('OtherFlags', 'PlatformTarget', 'WarningLevel'):
        if dbg.get(k):
            header.append(f'    <{k}>{dbg[k]}</{k}>')
    header.append('  </PropertyGroup>')
    for c in ('Debug', 'Release'):
        vals = cfg.get(c, {})
        lines = [f'    <{k}>{vals[k]}</{k}>' for k in ('Tailcalls', 'DefineConstants') if vals.get(k)]
        if lines:
            header += [f"  <PropertyGroup Condition=\"'$(Configuration)' == '{c}'\">", *lines, '  </PropertyGroup>']

    text = re.sub(r'<Project [^>]*>\s*\n', '<Project Sdk="Microsoft.NET.Sdk">\n' + '\n'.join(header) + '\n', text, count=1)
    text = re.sub(r'^<\?xml[^>]*\?>\s*\n', '', text)
    path.write_text(text, encoding='utf-8')
    print(f'converted: {path} {glob_props}')


if __name__ == '__main__':
    root = Path(sys.argv[1] if len(sys.argv) > 1 else 'src')
    for p in sorted(root.glob('*/*.fsproj')):
        convert(p)
