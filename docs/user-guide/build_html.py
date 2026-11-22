"""build_html.py: render the user guide's Markdown pages into ONE self-contained HTML file for
the Windows zip: every page in order, a page list, search across every page, Light and Dark,
screenshots embedded, no network.

    python build_html.py <out.html>          (needs the `markdown` package on PYTHONPATH)

The same pages/ folder is the guide's website (Starlight, astro.config.mjs). Each page's front
matter gives its title and its place in the list (`sidebar: order`, and `label` when the list
names it differently), so both outputs read one copy of the pages.
"""
import base64
import html
import json
import pathlib
import re
import sys

import markdown

HERE = pathlib.Path(__file__).parent
PAGES = HERE / "pages"


FRONT = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def front(file):
    """(front-matter fields, body) of a page. Only the flat keys the guide uses are read."""
    text = (PAGES / file).read_text(encoding="utf-8")
    m = FRONT.match(text)
    if not m:
        raise SystemExit(f"{file}: no front matter (needs title: and sidebar: order:)")
    fields = dict(re.findall(r"^[ \t]*(\w+):[ \t]*(\S.*?)[ \t]*$", m[1], re.M))
    return fields, text[m.end():]


def nav():
    """[(label, title, file)] in sidebar order."""
    items = []
    for path in PAGES.glob("*.md"):
        f, _ = front(path.name)
        items.append((int(f["order"]), f.get("label", f["title"]), f["title"], path.name))
    return [i[1:] for i in sorted(items)]


def slug(file):
    return "page-" + file.removesuffix(".md")


def render(title, file):
    md = markdown.Markdown(extensions=["tables", "fenced_code", "toc"])
    body = f"<h1>{html.escape(title)}</h1>\n" + md.convert(front(file)[1])
    sid = slug(file)
    # Heading ids are per page on the website; prefix them so they're unique in one file.
    body = re.sub(r'<h([1-6]) id="([^"]+)"', lambda m: f'<h{m[1]} id="{sid}--{m[2]}"', body)
    # Links between pages: x.md -> #page-x, x.md#y -> #page-x--y.
    body = re.sub(
        r'href="([\w-]+)\.md(?:#([\w-]+))?"',
        lambda m: f'href="#{slug(m[1] + ".md")}{"--" + m[2] if m[2] else ""}"',
        body,
    )

    def inline(m):
        path = PAGES / m[2]
        if not path.exists():
            print(f"  missing image: {m[2]}", file=sys.stderr)
            return m[0]
        data = base64.b64encode(path.read_bytes()).decode()
        return f'<img{m[1]}src="data:image/png;base64,{data}"'

    body = re.sub(r'<img([^>]*?)src="([^"]+\.png)"', inline, body)
    return body


CSS = """
:root{--bg:#f7f7f5;--surface:#fff;--text:#1c1c1c;--muted:#5f5f5f;--line:#e3e1dc;--accent:#8a6a22;
--accent-soft:#f3ecdc;--code:#f1efea;--mark:#f6e3a8}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b1b;--surface:#242424;--text:#ececec;--muted:#a8a8a8;
--line:#3a3a3a;--accent:#d8b45e;--accent-soft:#3a3222;--code:#2e2e2e;--mark:#6b5520}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
.layout{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}
nav{position:sticky;top:0;height:100vh;overflow-y:auto;padding:20px 16px;border-right:1px solid var(--line);background:var(--surface)}
.brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:16px;margin-bottom:16px}
.brand svg{flex:none}
#q{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}
#q:focus{outline:2px solid var(--accent);outline-offset:-1px}
nav ol{list-style:none;margin:16px 0 0;padding:0}
nav li a{display:block;padding:6px 10px;border-radius:6px;color:var(--text);text-decoration:none}
nav li a:hover{background:var(--accent-soft)}nav li a.on{background:var(--accent-soft);font-weight:600}
#results{margin-top:12px}#results a{display:block;padding:8px 10px;border-radius:6px;color:var(--text);text-decoration:none}
#results a:hover{background:var(--accent-soft)}#results b{display:block;font-size:13px}
#results span{display:block;font-size:12.5px;color:var(--muted)}#results p{font-size:13px;color:var(--muted);margin:4px 10px}
mark{background:var(--mark);color:inherit;border-radius:2px}
main{padding:32px 48px 96px;max-width:900px}
section{padding-bottom:40px;margin-bottom:40px;border-bottom:1px solid var(--line)}
h1{font-size:28px;line-height:1.25;margin:0 0 16px}h2{font-size:20px;margin:32px 0 8px}h3{font-size:16px}
a{color:var(--accent)}img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;margin:8px 0}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600}code,pre{background:var(--code);border-radius:4px;font-family:Consolas,monospace;font-size:13.5px}
code{padding:1px 5px}pre{padding:10px 14px;overflow-x:auto}pre code{padding:0}
.top{display:none}
@media (max-width:760px){.layout{display:block}nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}
main{padding:24px 16px 64px}}
"""

JS = """
const pages=[...document.querySelectorAll('main section')];
// The search index: one entry per heading block (a page's intro or one of its sections).
const index=[];
for(const s of pages){
  const title=s.querySelector('h1').textContent;let cur={page:title,head:title,id:s.id,text:''};
  for(const el of s.children){
    if(el.tagName==='H2'||el.tagName==='H3'){index.push(cur);cur={page:title,head:el.textContent,id:el.id,text:''}}
    else if(el.tagName!=='H1')cur.text+=' '+el.textContent;
  }
  index.push(cur);
}
const q=document.getElementById('q'),res=document.getElementById('results'),toc=document.getElementById('toc');
const esc=t=>t.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function snippet(text,words){
  const low=text.toLowerCase();let at=low.indexOf(words[0]);if(at<0)at=0;
  // Start and end on word boundaries, not mid-word.
  let st=Math.max(0,at-40);if(st>0){const sp=text.indexOf(' ',st);if(sp>-1&&sp<at)st=sp+1}
  let en=at+110;const sp2=text.lastIndexOf(' ',en);if(sp2>at)en=sp2;
  let s=text.slice(st,en).replace(/\\s+/g,' ').trim();s=esc(s);
  for(const w of words)s=s.replace(new RegExp('('+w.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')+')','gi'),'<mark>$1</mark>');
  return (st>0?'… ':'')+s+(en<text.length?' …':'');
}
q.addEventListener('input',()=>{
  const words=q.value.toLowerCase().split(/\\s+/).filter(w=>w.length>1);
  if(!words.length){res.innerHTML='';toc.hidden=false;return}
  toc.hidden=true;
  const hits=index.map(e=>{const hay=(e.head+' '+e.text).toLowerCase();
    if(!words.every(w=>hay.includes(w)))return null;
    const score=words.reduce((n,w)=>n+(e.head.toLowerCase().includes(w)?5:0)+hay.split(w).length-1,0);
    return {e,score}}).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,12);
  res.innerHTML=hits.length?hits.map(({e})=>`<a href="#${e.id}"><b>${esc(e.head)}</b>`+
    (e.head!==e.page?`<span>${esc(e.page)}</span>`:'')+`<span>${snippet(e.text||e.head,words)}</span></a>`).join('')
    :'<p>Nothing found. Try another word.</p>';
});
q.addEventListener('keydown',e=>{if(e.key==='Escape'){q.value='';q.dispatchEvent(new Event('input'))}
  if(e.key==='Enter'){const a=res.querySelector('a');if(a)a.click()}});
document.addEventListener('keydown',e=>{if((e.key==='/'||(e.ctrlKey&&e.key==='k'))&&document.activeElement!==q){e.preventDefault();q.focus()}});
// Mark the page in view in the page list.
const links=new Map([...toc.querySelectorAll('a')].map(a=>[a.hash.slice(1),a]));
const io=new IntersectionObserver(es=>{for(const e of es)if(e.isIntersecting){
  links.forEach(a=>a.classList.remove('on'));links.get(e.target.id)?.classList.add('on')}},
  {rootMargin:'-10% 0px -80% 0px'});
pages.forEach(p=>io.observe(p));
"""

MARK = (
    '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 21.5 12 12 21.5'
    ' 2.5 12Z" fill="none" stroke="#c9a24b" stroke-width="2.2" stroke-linejoin="round"/></svg>'
)


def main():
    out = pathlib.Path(sys.argv[1])
    items = nav()
    sections = "\n".join(f'<section id="{slug(f)}">{render(t, f)}</section>' for _, t, f in items)
    toc = "\n".join(f'<li><a href="#{slug(f)}">{html.escape(label)}</a></li>' for label, _, f in items)
    doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Miserly guide</title><style>{CSS}</style></head>
<body><div class="layout">
<nav aria-label="Guide"><div class="brand">{MARK}Miserly guide</div>
<input id="q" type="search" placeholder="Search the guide" aria-label="Search the guide" autocomplete="off">
<div id="results" aria-live="polite"></div>
<ol id="toc">{toc}</ol></nav>
<main>{sections}</main></div>
<script>{JS}</script></body></html>"""
    out.write_text(doc, encoding="utf-8")
    print(f"{out} ({out.stat().st_size // 1024} KB, {len(items)} pages)")


if __name__ == "__main__":
    main()
