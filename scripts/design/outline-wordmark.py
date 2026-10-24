"""Outline local OFL Inter glyphs; requires fonttools[woff]. No system font dependency."""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
ROOT = Path(__file__).resolve().parents[2]
fontpath = ROOT/'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'
def paths(text, size, weight, x, y, skew=0):
    font = instantiateVariableFont(TTFont(fontpath), {'wght':weight}, inplace=True)
    glyphs = font.getGlyphSet(); cmap = font.getBestCmap(); scale = size/font['head'].unitsPerEm
    output=[]
    for char in text:
        name=cmap[ord(char)]; pen=SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen,(scale,0,skew*scale,-scale,x,y)))
        output.append('<path d="'+pen.getCommands()+'"/>');x+=glyphs[name].width*scale
    return ''.join(output)
word='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 106" role="img" aria-label="CROT Control Center"><g fill="#1B2236">'+paths('CROT',70,800,25,65,.16)+'</g><g fill="#5B6B84">'+paths('Control Center',26,500,32,98)+'</g></svg>\n'
(ROOT/'assets/brand/crot-wordmark.svg').write_text(word)
