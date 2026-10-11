# gen-concept-cars.py — model the CONCEPT CARS in Blender and export them as
# kit-format GLBs into public/assets/concepts/, for the asset gallery's
# "Concept cars" field. Nothing in a race draws them; they are candidates.
#
#   blender -b --factory-startup --python scripts/gen-concept-cars.py [-- name ...]
#
# The models are PROCEDURAL SOURCE, like gen-props.mjs: edit a builder below,
# re-run, commit the .glb outputs. They follow the toy-car kit's own format so
# any of them could be dropped into the roster as is:
#   * Blender +Y is the nose (glTF -Z after export, the kit's facing);
#   * a root node holding the body mesh, wheel-fl/fr/bl/br as its children,
#     left and right wheels sharing one mesh per side (dedupe-wheel-meshes.mjs);
#   * one material on the kit's shared Textures/colormap.png, by URI, with the
#     kit's empty KHR_texture_transform (the vglb material needs it);
#   * every face UV'd into one atlas swatch, with v running down the swatch as
#     the vertex rises — the kit's own light-on-top gradient, and the 0.5..0.75
#     paint band ttpSeatMarks stripes on a player's car.
# The "plus" builders start from a roster car's GLB and add to it.

import bmesh
import bpy
import json
import math
import os
import struct
import sys
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
KIT = os.path.join(REPO, 'public', 'assets', 'toycar')
OUT = os.path.join(REPO, 'public', 'assets', 'concepts')

# Swatches as (row, column) of the 4 x 16 grid of 32 px cells. Row 2 is the
# paint band; odd columns carry a gradient, even ones are flat.
CREAM, GREEN, GOLD, ORANGE, RED, BLUE, PURPLE = (2, 1), (2, 3), (2, 5), (2, 7), (2, 9), (2, 11), (2, 15)
SKY = (2, 12)
GLASS = (2, 13)
LAMP_RED, LAMP_AMBER = (2, 8), (2, 4)
INK, CHARCOAL = (3, 0), (3, 1)   # near-black
STEEL = (3, 3)                   # the kit's grey-blue trim
TYRE = (3, 5)                    # the kit's tyre slate
SILVER = (3, 7)
WHITE, CHROME = (3, 8), (3, 9)
TAN, LEATHER = (3, 14), (3, 13)

SWATCHES = {}  # swatch -> material slot, for the join


# ---------------------------------------------------------------- scene parts

def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def mesh_obj(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me))


def tag(obj, swatch):
    """Give every face of obj the material slot standing for `swatch`."""
    if swatch not in SWATCHES:
        mat = bpy.data.materials.new(f"sw_{swatch[0]}_{swatch[1]}")
        mat['swatch'] = list(swatch)
        SWATCHES[swatch] = mat
    obj.data.materials.clear()
    obj.data.materials.append(SWATCHES[swatch])
    return obj


def bevel(obj, width, segments=2, angle=35):
    if width <= 0:
        obj.data.set_sharp_from_angle(angle=math.radians(angle))
        for p in obj.data.polygons:
            p.use_smooth = True
        return obj
    for p in obj.data.polygons:
        p.use_smooth = True
    m = obj.modifiers.new("bevel", 'BEVEL')
    m.width = width
    m.segments = segments
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(angle)
    m.harden_normals = True
    m.miter_outer = 'MITER_ARC'
    return obj


def hull(name, pts, swatch, bev=0.012, segments=1, angle=35):
    """The convex hull of pts, bevelled: the one shape almost everything is."""
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(p)
    res = bmesh.ops.convex_hull(bm, input=list(bm.verts))
    loose = [v for v in dict.fromkeys(res['geom_interior'] + res['geom_unused']) if isinstance(v, bmesh.types.BMVert)]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1), verts=list(bm.verts), edges=list(bm.edges))
    return bevel(tag(mesh_obj(name, bm), swatch), bev, segments, angle)


def box(name, lo, hi, swatch, bev=0.0, segments=1):
    (x0, y0, z0), (x1, y1, z1) = lo, hi
    return hull(name, [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)], swatch, bev, segments)


def taper(name, bottom, top, swatch, bev=0.014, segments=1, cx=0.0):
    """A frustum between two rectangles: bottom/top = (halfX, yBack, yFront, z)."""
    pts = []
    for hx, yb, yf, z in (bottom, top):
        pts += [(cx - hx, yb, z), (cx + hx, yb, z), (cx - hx, yf, z), (cx + hx, yf, z)]
    return hull(name, pts, swatch, bev, segments)


def profile(name, half_x, side, swatch, bev=0.014, segments=1, cx=0.0):
    """Extrude a side profile [(y, z), ...] (convex) across +-half_x."""
    pts = [(cx + s * half_x, y, z) for y, z in side for s in (-1, 1)]
    return hull(name, pts, swatch, bev, segments)


def cyl(name, p0, p1, r, swatch, seg=8, r1=None, caps=True):
    """A cylinder (or cone, with r1) from p0 to p1: smooth sides, flat caps."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=seg,
                          radius1=r, radius2=r if r1 is None else r1, depth=d.length)
    rot = d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p0 + p1) / 2) @ rot, verts=list(bm.verts))
    return bevel(tag(mesh_obj(name, bm), swatch), 0, angle=50)


def disc(name, centre, normal, r, depth, swatch, seg=12):
    """A thin cylinder standing proud of a surface along `normal`."""
    c, n = Vector(centre), Vector(normal).normalized()
    return cyl(name, c, c + n * depth, r, swatch, seg)


def tube(name, pts, r, swatch, seg=6):
    """A bent bar through pts: one cylinder per leg, each overrunning the
    joint by a radius so the bends close."""
    out = []
    for i in range(len(pts) - 1):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        d = (b - a).normalized() * r
        out.append(cyl(f"{name}{i}", a - d * (i > 0), b + d * (i < len(pts) - 2), r, swatch, seg))
    return out


# --------------------------------------------------------------------- wheels

def kit_wheels(src='vehicle-racer'):
    """The kit's wheel meshes (left, right), lifted out of a roster GLB."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KIT, src + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    left = next(o for o in new if o.name.startswith('wheel-fl')).data
    right = next(o for o in new if o.name.startswith('wheel-fr')).data
    for o in new:
        bpy.data.objects.remove(o)
    return left, right


def knobby_wheel(name, r, w, knobs=10, rim=CHROME, rim_r=0.5):
    """An off-road tyre with tread blocks staggered across the tread, hubcap
    on the +x face (the left wheels take a mirrored copy)."""
    parts = [cyl(f"{name}-tyre", (-w / 2, 0, 0), (w / 2, 0, 0), r * 0.88, TYRE, seg=14)]
    hw = r * 0.14
    for i in range(knobs):
        a = 2 * math.pi * i / knobs
        ca, sa = math.cos(a), math.sin(a)
        xa, xb = (-w / 2, w * 0.2) if i % 2 else (-w * 0.2, w / 2)
        pts = [(x, rr * sa + s * ca, rr * ca - s * sa)
               for rr in (r * 0.84, r) for s in (-hw, hw) for x in (xa, xb)]
        parts.append(hull(f"{name}-knob{i}", pts, TYRE, 0))
    parts.append(disc(f"{name}-rim", (w / 2 - 0.004, 0, 0), (1, 0, 0), r * rim_r, 0.012, rim, 10))
    parts.append(disc(f"{name}-hub", (w / 2, 0, 0), (1, 0, 0), r * 0.16, 0.016, INK, 6))
    return join(parts, name)


# ------------------------------------------------------------- join and paint

def join(objs, name):
    """Apply every modifier and merge objs into one mesh object."""
    objs = [o for o in objs if o is not None]
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    for o in objs:
        bpy.context.view_layer.objects.active = o
        for m in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.context.view_layer.objects.active = objs[0]
    if os.environ.get('CONCEPT_DEBUG'):
        cost = sorted(((sum(len(p.vertices) - 2 for p in o.data.polygons), o.name) for o in objs), reverse=True)
        print(name, cost[:25])
    for o in objs:
        o.select_set(True)
    bpy.ops.object.join()
    out = bpy.context.view_layer.objects.active
    out.name = name
    out.data.name = name
    return out


def paint_uvs(obj):
    """UV every face into its slot's swatch: u at the column's centre, v down
    the swatch as the vertex rises over the object's height range — or over
    its source body's `zrange`, so added parts shade like the parts they sit
    on — which is the kit's own mapping."""
    me = obj.data
    zs = [v.co.z for v in me.vertices]
    zlo, zhi = obj.get('zrange', (min(zs), max(zs)))
    span = max(zhi - zlo, 1e-6)
    uv = me.uv_layers.active or me.uv_layers.new(name='UVMap')
    for p in me.polygons:
        mat = me.materials[p.material_index]
        if mat is None or 'swatch' not in mat:
            continue  # kept from a source GLB: its UVs are already the kit's
        row, col = mat['swatch']
        for li in p.loop_indices:
            z = me.vertices[me.loops[li].vertex_index].co.z
            t = min(max((z - zlo) / span, 0.0), 1.0)
            v = row * 0.25 + 0.025 + 0.2 * (1.0 - t)
            uv.data[li].uv = ((col + 0.5) / 16.0, 1.0 - v)


# --------------------------------------------------------------------- export

def export(name, body, wheels):
    """Write OUT/<name>.glb: body at the root, the wheel (and axle) nodes,
    given as (name, mesh, location), as its children."""
    bpy.ops.object.select_all(action='DESELECT')
    body.name = name
    keep = [body]
    for wname, mesh, loc in wheels:
        o = link(bpy.data.objects.new(wname, mesh))
        o.parent = body
        o.location = loc
        keep.append(o)
    for o in keep:
        o.select_set(True)
    path = os.path.join(OUT, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_image_format='NONE', export_tangents=False,
                              export_yup=True, export_apply=False, export_extras=False)
    kit_material(path)
    tris = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in keep}
    print(f"wrote {name}.glb ({sum(tris.values())} tris: {tris})")
    return sum(tris.values())


def kit_material(path):
    """Rewrite the export to the kit's layout: the single colormap material,
    and the root node first."""
    with open(path, 'rb') as f:
        data = f.read()
    jlen = struct.unpack_from('<I', data, 12)[0]
    doc = json.loads(data[20:20 + jlen])
    rest = data[20 + jlen:]
    doc['extensionsUsed'] = ['KHR_texture_transform']
    doc.pop('extensionsRequired', None)
    doc['images'] = [{'uri': 'Textures/colormap.png', 'name': 'colormap'}]
    doc['samplers'] = [{'magFilter': 9728, 'minFilter': 9984}]
    doc['textures'] = [{'sampler': 0, 'source': 0, 'name': 'colormap'}]
    doc['materials'] = [{
        'pbrMetallicRoughness': {
            'baseColorTexture': {'index': 0, 'extensions': {'KHR_texture_transform': {'texCoord': 0}}},
            'metallicFactor': 0,
        },
        'doubleSided': True,
        'name': 'colormap',
    }]
    for mesh in doc['meshes']:
        for p in mesh['primitives']:
            p['material'] = 0
    root = doc['scenes'][0]['nodes'][0]
    order = [root] + [i for i in range(len(doc['nodes'])) if i != root]
    where = {old: new for new, old in enumerate(order)}
    doc['nodes'] = [doc['nodes'][i] for i in order]
    for n in doc['nodes']:
        if 'children' in n:
            n['children'] = [where[c] for c in n['children']]
    doc['scenes'] = [{'nodes': [0], 'name': doc['nodes'][0]['name']}]
    js = json.dumps(doc, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + len(rest))
    out += struct.pack('<II', len(js), 0x4E4F534A) + js + rest
    with open(path, 'wb') as f:
        f.write(out)


def fresh():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    SWATCHES.clear()


def merge_slots(obj):
    """One material slot for the whole body, so the export is one primitive
    per mesh — after paint_uvs has read the slots."""
    me = obj.data
    me.materials.clear()
    me.materials.append(bpy.data.materials.get('colormap') or bpy.data.materials.new('colormap'))


# ======================================================================= cars
#
# One vocabulary across the set, Carve plus's: a WING with endplates and a
# gurney, LAMPS front and back, and HOOD detail (a grille, louvres or a
# scoop). Nothing else is added — no mirrors, side glass, pipes, roundels,
# canards or diffusers — so the extras stay few and read at chase-cam size.

def louvres(S, parts, x0, x1, ys, w=0.007):
    """Vent slits across the bonnet, a set each side of the centre line."""
    for s in (-1, 1):
        for i, y in enumerate(ys):
            parts.append(S.patch(f'louvre{s}{i}', 'z+', (s * x0, s * x1, y - w, y + w), INK, 0.003))


def round_lamps(S, parts, xs, z, r):
    for s in (-1, 1):
        for x in xs:
            parts.append(S.disc(f'head{s}{x}', 'y+', s * x, z, r, WHITE))


def tail_lamps(S, parts, x0, x1, z0, z1):
    for s in (-1, 1):
        parts.append(S.patch(f'tail{s}', 'y-', (s * x0, s * x1, z0, z1), LAMP_RED, 0.006))


def endplates(parts, swatch, half_x, side):
    """A wing's endplates: the side profile [(y, z), ...] at +-half_x."""
    for s in (-1, 1):
        parts.append(profile(f'plate{s}', 0.006, side, swatch, 0, cx=s * half_x))


def gurney(parts, half_x, y, z):
    """The lip along a wing's trailing edge, y its back face, z its top."""
    parts.append(box('gurney', (-half_x, y - 0.002, z - 0.004), (half_x, y + 0.008, z + 0.012), CHARCOAL))


def shell(parts):
    """Join the shell built so far, and a Surface to seat details on it."""
    body = join(parts, 'body')
    return body, Surface(body), [body]


def buggy():
    """RC off-road buggy: cab-forward shell, roll cage, open engine and knobby
    tyres, with the wing, round lamps and nose louvres."""
    P = GOLD
    parts = []
    parts.append(taper('tub', (0.12, -0.36, 0.30, 0.06), (0.13, -0.38, 0.34, 0.12), CHARCOAL, 0.01))
    parts.append(profile('nose', 0.12, [(0.44, 0.12), (0.44, 0.17), (0.16, 0.25), (0.10, 0.25), (0.10, 0.11)], P, 0.02))
    parts.append(taper('cowl', (0.16, -0.10, 0.18, 0.11), (0.15, -0.08, 0.14, 0.24), P, 0.02))
    parts.append(profile('screen', 0.12, [(0.15, 0.24), (0.04, 0.32), (0.0, 0.32), (0.0, 0.24)], GLASS, 0.01))
    for s in (-1, 1):
        parts.append(taper(f'pod{s}', (0.035, -0.20, 0.10, 0.10), (0.03, -0.18, 0.06, 0.20), P, 0.012, cx=s * 0.16))
    parts.append(box('seat', (-0.07, -0.12, 0.2), (0.07, -0.07, 0.31), CHARCOAL, 0.012))
    for s in (-1, 1):
        parts += tube(f'hoop{s}', [(s * 0.13, -0.09, 0.22), (s * 0.11, -0.09, 0.39), (s * 0.10, 0.06, 0.37),
                                   (s * 0.135, 0.16, 0.24)], 0.012, CHARCOAL)
        parts += tube(f'brace{s}', [(s * 0.11, -0.09, 0.39), (s * 0.10, -0.26, 0.24)], 0.010, CHARCOAL)
    parts.append(cyl('hoopTop', (-0.11, -0.09, 0.39), (0.11, -0.09, 0.39), 0.012, CHARCOAL))
    parts.append(cyl('hoopFront', (-0.10, 0.06, 0.37), (0.10, 0.06, 0.37), 0.012, CHARCOAL))
    parts.append(box('block', (-0.08, -0.34, 0.11), (0.08, -0.15, 0.22), STEEL, 0.015))
    parts.append(profile('wing', 0.19, [(-0.32, 0.355), (-0.44, 0.335), (-0.44, 0.355), (-0.32, 0.375)], P, 0.008))
    for s in (-1, 1):
        parts.append(box(f'strut{s}', (s * 0.06 - 0.008, -0.38, 0.2), (s * 0.06 + 0.008, -0.35, 0.35), CHARCOAL))
    endplates(parts, CHARCOAL, 0.195, [(-0.45, 0.31), (-0.45, 0.38), (-0.31, 0.39), (-0.33, 0.33)])
    gurney(parts, 0.19, -0.44, 0.355)
    body, S, parts = shell(parts)
    round_lamps(S, parts, (0.07,), 0.145, 0.02)
    louvres(S, parts, 0.03, 0.09, (0.24, 0.27, 0.30))
    tail_lamps(S, parts, 0.14, 0.18, 0.13, 0.16)
    body = join(parts, 'body')
    fl = knobby_wheel('wheelF', 0.115, 0.095)
    rl = knobby_wheel('wheelR', 0.13, 0.12)
    paint_uvs(fl)
    paint_uvs(rl)
    return body, [('wheel-fl', mirrored_pair(fl), (-0.19, 0.26, 0.115)), ('wheel-fr', fl, (0.19, 0.26, 0.115)),
                  ('wheel-bl', mirrored_pair(rl), (-0.19, -0.24, 0.13)), ('wheel-br', rl, (0.19, -0.24, 0.13))]


def kit_wheel_set(xs, yf, yb, r=0.125, src='vehicle-racer'):
    """The kit's own wheels at +-xs, front axle yf, rear yb, scaled to radius r."""
    left, right = kit_wheels(src)
    # baked, not a node scale: the renderer rewrites the wheel nodes' transforms
    for me in (left, right):
        me.transform(Matrix.Scale(r / 0.125, 4))
    return [('wheel-fl', left, (-xs, yf, r)), ('wheel-fr', right, (xs, yf, r)),
            ('wheel-bl', left, (-xs, yb, r)), ('wheel-br', right, (xs, yb, r))]


def side_pillar(name, s, a, b, swatch, inset=0.03):
    """A window pillar on side s: a band over the cabin's side from the belt
    point a=(x, y, z) to the roof point b, `inset` deep into the glass."""
    pts = []
    for x, y, z in (a, b):
        for dy in (-0.018, 0.018):
            pts += [(s * (x + 0.003), y + dy, z), (s * (x - inset), y + dy, z)]
    return hull(name, pts, swatch, 0)


def rally():
    """Rally hatch: boxy shell with flared arches, with a roof spoiler, two
    driving lamps on the bumper, a bonnet scoop and a grille."""
    P = LAMP_RED  # the flat crimson: column 9 is Bolt's
    parts = []
    parts.append(profile('shell', 0.235, [(0.44, 0.10), (0.44, 0.215), (0.37, 0.26), (-0.40, 0.27),
                                          (-0.435, 0.24), (-0.435, 0.10)], P, 0.022))
    for s in (-1, 1):
        for y in (0.26, -0.26):
            parts.append(profile(f'arch{s}{y}', 0.02, [(y + 0.15, 0.14), (y + 0.12, 0.235), (y - 0.12, 0.235),
                                                      (y - 0.15, 0.14)], P, 0.012, cx=s * 0.24))
    parts.append(box('sill', (-0.225, -0.13, 0.075), (0.225, 0.13, 0.11), STEEL))
    parts.append(box('fbump', (-0.245, 0.42, 0.075), (0.245, 0.475, 0.15), STEEL, 0.015))
    parts.append(box('rbump', (-0.245, -0.47, 0.075), (0.245, -0.42, 0.15), STEEL, 0.015))
    parts.append(taper('glass', (0.212, -0.385, 0.15, 0.255), (0.172, -0.345, -0.02, 0.38), GLASS, 0.008))
    parts.append(taper('roof', (0.178, -0.355, -0.005, 0.372), (0.168, -0.345, -0.025, 0.40), P, 0.012))
    for s in (-1, 1):
        parts.append(side_pillar(f'apil{s}', s, (0.212, 0.14, 0.258), (0.172, -0.01, 0.378), P))
        parts.append(side_pillar(f'bpil{s}', s, (0.212, -0.12, 0.258), (0.172, -0.13, 0.378), P))
        parts.append(side_pillar(f'cpil{s}', s, (0.212, -0.365, 0.258), (0.172, -0.33, 0.378), P, 0.05))
    parts.append(profile('spoiler', 0.17, [(-0.33, 0.395), (-0.42, 0.385), (-0.42, 0.405), (-0.33, 0.41)], P, 0.006))
    endplates(parts, P, 0.176, [(-0.33, 0.375), (-0.425, 0.375), (-0.425, 0.42), (-0.34, 0.42)])
    gurney(parts, 0.17, -0.42, 0.405)
    body, S, parts = shell(parts)
    for s in (-1, 1):
        parts.append(S.patch(f'head{s}', 'y+', (s * 0.14, s * 0.215, 0.165, 0.205), WHITE))
        parts.append(cyl(f'lampCan{s}', (s * 0.09, 0.44, 0.185), (s * 0.09, 0.47, 0.185), 0.03, CHARCOAL, 10))
        parts.append(disc(f'lamp{s}', (s * 0.09, 0.47, 0.185), (0, 1, 0), 0.022, 0.006, WHITE, 10))
    parts.append(S.patch('grille', 'y+', (-0.11, 0.11, 0.155, 0.205), INK))
    h = S.height(0, 0.33)
    parts.append(profile('scoop', 0.06, [(0.33, h - 0.004), (0.33, h + 0.024), (0.22, h + 0.02),
                                         (0.19, S.height(0, 0.19) - 0.004)], P, 0.008))
    parts.append(box('scoopMouth', (-0.048, 0.33, h + 0.003), (0.048, 0.334, h + 0.019), INK))
    # red on red needs a dark panel to read as lamps
    # corners on the tail's flat: on the bevel they would bury the panel's middle
    parts.append(S.patch('tailPanel', 'y-', (-0.205, 0.205, 0.172, 0.214), INK, 0.003))
    for s in (-1, 1):
        parts.append(S.patch(f'tail{s}', 'y-', (s * 0.13, s * 0.195, 0.18, 0.206), LAMP_RED, 0.007))
    return join(parts, 'body'), kit_wheel_set(0.19, 0.26, -0.26)


def gt():
    """Le Mans GT: long low wedge, tinted bubble cockpit over fender humps,
    with a full-width wing, wedge lamps, tail lamps and bonnet louvres."""
    P = SKY
    parts = []
    parts.append(box('floor', (-0.215, -0.44, 0.05), (0.215, 0.46, 0.095), CHARCOAL))
    parts.append(profile('hull', 0.2, [(0.47, 0.085), (0.47, 0.12), (0.30, 0.185), (-0.36, 0.215),
                                       (-0.45, 0.205), (-0.45, 0.085)], P, 0.02))
    for s in (-1, 1):
        parts.append(profile(f'ffender{s}', 0.045, [(0.42, 0.10), (0.40, 0.17), (0.30, 0.235), (0.18, 0.225),
                                                    (0.12, 0.10)], P, 0.016, cx=s * 0.205))
        parts.append(profile(f'rfender{s}', 0.05, [(-0.10, 0.10), (-0.16, 0.235), (-0.30, 0.265), (-0.42, 0.245),
                                                   (-0.45, 0.10)], P, 0.016, cx=s * 0.205))
        parts.append(hull(f'head{s}', [(s * 0.17, 0.40, 0.165), (s * 0.235, 0.385, 0.165), (s * 0.17, 0.36, 0.198),
                                        (s * 0.235, 0.345, 0.198), (s * 0.17, 0.40, 0.155), (s * 0.235, 0.39, 0.155)],
                          WHITE, 0))
    parts.append(taper('canopy', (0.155, -0.21, 0.19, 0.19), (0.11, -0.13, 0.03, 0.325), INK, 0.012))
    parts.append(taper('roof', (0.116, -0.145, 0.025, 0.318), (0.104, -0.13, 0.01, 0.34), P, 0.01))
    parts.append(profile('wing', 0.212, [(-0.38, 0.345), (-0.47, 0.335), (-0.47, 0.35), (-0.38, 0.36)], CHARCOAL, 0.005))
    endplates(parts, P, 0.215, [(-0.38, 0.26), (-0.47, 0.27), (-0.47, 0.36), (-0.39, 0.355)])
    gurney(parts, 0.212, -0.47, 0.35)
    for s in (-1, 1):
        parts.append(box(f'tail{s}', (s * 0.07, -0.456, 0.17), (s * 0.18, -0.448, 0.19), LAMP_RED))
    parts.append(box('grille', (-0.09, 0.465, 0.09), (0.09, 0.472, 0.115), INK))
    body, S, parts = shell(parts)
    louvres(S, parts, 0.035, 0.12, (0.31, 0.34, 0.37))
    return join(parts, 'body'), kit_wheel_set(0.195, 0.27, -0.27)


def pip():
    """Bubble micro car: short rounded shell, glass bubble with a painted cap
    and chrome bumpers, with frog-eye lamps, a lip spoiler and bonnet louvres."""
    P = CREAM
    parts = []
    parts.append(profile('shell', 0.205, [(0.34, 0.09), (0.37, 0.15), (0.35, 0.22), (0.26, 0.27), (-0.26, 0.28),
                                          (-0.34, 0.24), (-0.36, 0.16), (-0.33, 0.09)], P, 0.04, 2))
    parts.append(profile('bubble', 0.17, [(0.18, 0.26), (0.10, 0.36), (0.0, 0.40), (-0.14, 0.40), (-0.24, 0.35),
                                          (-0.27, 0.26)], GLASS, 0.03, 2))
    parts.append(profile('cap', 0.15, [(0.04, 0.395), (0.0, 0.41), (-0.14, 0.41), (-0.2, 0.39)], P, 0.015, 2))
    parts.append(profile('spoiler', 0.13, [(-0.12, 0.408), (-0.215, 0.402), (-0.215, 0.416), (-0.12, 0.422)], P, 0.005))
    gurney(parts, 0.13, -0.215, 0.414)
    parts.append(box('belt', (-0.21, -0.3, 0.255), (0.21, 0.27, 0.27), STEEL))
    for s in (-1, 1):
        parts.append(cyl(f'eyePod{s}', (s * 0.12, 0.22, 0.25), (s * 0.12, 0.31, 0.27), 0.05, P, 12))
        parts.append(disc(f'eyeRing{s}', (s * 0.12, 0.305, 0.27), (0, 1, 0.2), 0.05, 0.012, CHROME, 12))
        parts.append(disc(f'eyeLens{s}', (s * 0.12, 0.315, 0.272), (0, 1, 0.2), 0.036, 0.006, WHITE, 12))
        parts.append(box(f'tail{s}', (s * 0.12 - 0.025, -0.366, 0.17), (s * 0.12 + 0.025, -0.352, 0.21), LAMP_RED))
    parts += tube('fbumper', [(-0.2, 0.30, 0.10), (-0.17, 0.375, 0.11), (0.17, 0.375, 0.11), (0.2, 0.30, 0.10)], 0.014, CHROME)
    parts += tube('rbumper', [(-0.2, -0.29, 0.10), (-0.17, -0.37, 0.11), (0.17, -0.37, 0.11), (0.2, -0.29, 0.10)], 0.014, CHROME)
    parts.append(box('grille', (-0.06, 0.355, 0.14), (0.06, 0.37, 0.175), INK))
    body, S, parts = shell(parts)
    louvres(S, parts, 0.012, 0.055, (0.265, 0.29, 0.315), 0.006)
    return join(parts, 'body'), kit_wheel_set(0.18, 0.22, -0.2, r=0.105)


# ------------------------------------------------------- roster cars, plus

def kit_base(model):
    """A roster car as the start of a model: its body (UVs kept, its height
    range remembered for the parts added to it) and its wheel and axle nodes."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KIT, model + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    body = next(o for o in new if o.parent is None)
    zs = [v.co.z for v in body.data.vertices]
    body['zrange'] = (min(zs), max(zs))
    nodes = [(o.name.split('.')[0], o.data, tuple(o.location)) for o in new if o is not body]
    return body, nodes


FACES = {'x+': (0, 1), 'x-': (0, -1), 'y+': (1, 1), 'y-': (1, -1), 'z+': (2, 1)}


class Surface:
    """Raycasts onto a body, so details sit on its real faces. A face is the
    side a ray comes in from ('y+' is the nose); a point on it is named by
    the other two coordinates, in x, y, z order."""

    def __init__(self, obj):
        self.bvh = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())

    def ray(self, face, a, b):
        axis, sign = FACES[face]
        o = [a, b]
        o.insert(axis, sign * 3.0)
        d = [0.0, 0.0, 0.0]
        d[axis] = -sign
        loc, n, _, _ = self.bvh.ray_cast(Vector(o), Vector(d))
        if loc is None:
            raise ValueError(f"nothing under {face} at {a:.3f}, {b:.3f}")
        return loc, n

    def height(self, x, y):
        return self.ray('z+', x, y)[0].z

    def patch(self, name, face, rect, swatch, proud=0.004, depth=0.012):
        """A plate over the face, corners rect = (a0, a1, b0, b1) each projected
        onto the surface — a lamp or a vent on whatever slope is there."""
        a0, a1, b0, b1 = rect
        pts = []
        for a in (a0, a1):
            for b in (b0, b1):
                loc, n = self.ray(face, a, b)
                pts += [loc + n * proud, loc - n * depth]
        return hull(name, pts, swatch, 0)

    def disc(self, name, face, a, b, r, swatch, proud=0.006, seg=12):
        loc, n = self.ray(face, a, b)
        return disc(name, loc - n * 0.004, n, r, proud + 0.004, swatch, seg)


def dash_plus():
    """Dash with a touch more: endplates and a gurney on its spoiler, tail
    lamps across its back, square lamps, a grille, bonnet and roof scoops, a
    rear screen."""
    body, nodes = kit_base('vehicle-racer-low')
    S, P = Surface(body), GREEN
    parts = [body]
    for s in (-1, 1):
        parts.append(S.patch(f'head{s}', 'y+', (s * 0.10, s * 0.165, 0.222, 0.252), WHITE))
    parts.append(S.patch('grille', 'y+', (-0.07, 0.07, 0.218, 0.248), INK))
    h = S.height(0, 0.275)
    parts.append(profile('scoop', 0.055, [(0.275, h - 0.004), (0.275, h + 0.022), (0.19, h + 0.022),
                                          (0.17, S.height(0, 0.17) - 0.004)], P, 0.008))
    parts.append(box('scoopMouth', (-0.042, 0.275, h + 0.003), (0.042, 0.279, h + 0.017), INK))
    # the roof and the fastback are what the chase cam looks down on
    r = S.height(0, 0.0)
    parts.append(profile('roofScoop', 0.05, [(0.03, r - 0.004), (0.03, r + 0.022), (-0.05, r + 0.018),
                                             (-0.09, r - 0.004)], P, 0.006))
    parts.append(box('roofMouth', (-0.038, 0.03, r + 0.002), (0.038, 0.034, r + 0.016), INK))
    parts.append(S.patch('rearScreen', 'z+', (-0.1, 0.1, -0.14, -0.25), GLASS))
    endplates(parts, P, 0.25, [(-0.30, 0.29), (-0.43, 0.29), (-0.43, 0.37), (-0.31, 0.365)])
    gurney(parts, 0.244, -0.428, 0.344)
    # the tail under the spoiler hides from the chase cam: the lamps ride
    # the spoiler's back instead, on a dark band
    parts.append(S.patch('tailPanel', 'y-', (-0.21, 0.21, 0.304, 0.336), INK, 0.003))
    tail_lamps(S, parts, 0.10, 0.19, 0.309, 0.331)
    return join(parts, 'body'), nodes


def carve_plus():
    """Carve with a touch more: wing endplates and a gurney, twin round lamps,
    a grille, louvres on the bonnet and the roof, a rear screen, tail lamps."""
    body, nodes = kit_base('vehicle-racer')
    S, P = Surface(body), BLUE
    parts = [body]
    round_lamps(S, parts, (0.115, 0.158), 0.236, 0.018)
    louvres(S, parts, 0.035, 0.13, (0.185, 0.215, 0.245))
    parts.append(S.patch('grille', 'y+', (-0.075, 0.075, 0.218, 0.25), INK))
    endplates(parts, P, 0.25, [(-0.335, 0.37), (-0.445, 0.37), (-0.445, 0.455), (-0.345, 0.45)])
    gurney(parts, 0.244, -0.442, 0.425)
    louvres(S, parts, 0.035, 0.115, (-0.03, -0.06, -0.09))
    parts.append(S.patch('rearScreen', 'z+', (-0.1, 0.1, -0.15, -0.29), GLASS))
    tail_lamps(S, parts, 0.105, 0.175, 0.245, 0.275)
    return join(parts, 'body'), nodes


def bolt_plus():
    """Bolt with a touch more: endplates on both wings, nose louvres, tail
    lamps on a dark panel."""
    body, nodes = kit_base('vehicle-speedster')
    S, P = Surface(body), RED
    parts = [body]
    for s in (-1, 1):
        parts.append(profile(f'fplate{s}', 0.006, [(0.31, 0.07), (0.43, 0.07), (0.43, 0.165), (0.33, 0.155)],
                             P, 0, cx=s * 0.226))
    endplates(parts, P, 0.226, [(-0.34, 0.30), (-0.445, 0.30), (-0.445, 0.405), (-0.34, 0.40)])
    louvres(S, parts, 0.025, 0.075, (0.13, 0.16, 0.19))
    # red lamps on a red-orange tail need a dark panel to read
    parts.append(S.patch('tailPanel', 'y-', (-0.105, 0.105, 0.236, 0.284), INK, 0.003))
    tail_lamps(S, parts, 0.03, 0.09, 0.245, 0.275)
    return join(parts, 'body'), nodes


def rumble_plus():
    """Rumble with a touch more: a ducktail with endplates and a gurney, round
    lamps and a grille on the bonnet's face, bonnet louvres, tail lamps."""
    body, nodes = kit_base('vehicle-vintage-racer')
    S, P = Surface(body), PURPLE
    parts = [body]
    round_lamps(S, parts, (0.075,), 0.232, 0.021)
    parts.append(S.patch('grille', 'y+', (-0.04, 0.04, 0.205, 0.255), INK))
    louvres(S, parts, 0.025, 0.08, (0.20, 0.24, 0.28))
    parts.append(profile('ducktail', 0.085, [(-0.37, 0.236), (-0.44, 0.232), (-0.445, 0.258), (-0.38, 0.252)], P, 0.006))
    endplates(parts, P, 0.09, [(-0.37, 0.225), (-0.445, 0.225), (-0.445, 0.27), (-0.375, 0.262)])
    gurney(parts, 0.085, -0.445, 0.258)
    tail_lamps(S, parts, 0.03, 0.075, 0.175, 0.205)
    return join(parts, 'body'), nodes


def mirrored_pair(obj):
    """The left-side twin of a right wheel object's mesh (hubcap facing -x)."""
    me = obj.data.copy()
    me.transform(Matrix.Scale(-1, 4, (1, 0, 0)))
    me.flip_normals()
    return me


# name -> (builder, the roster model it starts from, if any). The order is
# the gallery's: the new directions, then each plus after its original.
CARS = {
    'concept-buggy': (buggy, None),
    'concept-rally': (rally, None),
    'concept-gt': (gt, None),
    'concept-pip': (pip, None),
    'dash-plus': (dash_plus, 'vehicle-racer-low'),
    'bolt-plus': (bolt_plus, 'vehicle-speedster'),
    'carve-plus': (carve_plus, 'vehicle-racer'),
    'rumble-plus': (rumble_plus, 'vehicle-vintage-racer'),
}


def build(name):
    fresh()
    body, wheels = CARS[name][0]()
    paint_uvs(body)
    merge_slots(body)
    resolved = []
    for wname, mesh, loc in wheels:
        if isinstance(mesh, bpy.types.Object):
            mesh = mesh.data
        if any(m and 'swatch' in m for m in mesh.materials):
            mesh.materials.clear()
            mesh.materials.append(body.data.materials[0])
        resolved.append((wname, mesh, loc))
    # the wheel objects built by the builder are only mesh carriers
    for o in list(bpy.data.objects):
        if o is not body:
            bpy.data.objects.remove(o)
    return export(name, body, resolved)


def write_index(tris):
    """OUT/index.json, the gallery's list: every car in CARS order with its
    triangle count, its builder's description and the roster car it builds
    on. Counts for cars not rebuilt this run are carried over."""
    path = os.path.join(OUT, 'index.json')
    old = {}
    if os.path.exists(path):
        with open(path) as f:
            old = {m['name']: m for m in json.load(f)['models']}
    models = []
    for name, (fn, base) in CARS.items():
        count = tris.get(name, old.get(name, {}).get('tris'))
        if count is None:
            continue
        m = {'name': name, 'tris': count, 'note': ' '.join(fn.__doc__.split())}
        if base:
            m['base'] = base
        models.append(m)
    with open(path, 'w') as f:
        json.dump({'_readme': 'Written by scripts/gen-concept-cars.py; read by the asset gallery.',
                   'models': models}, f, indent=1)
        f.write('\n')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    os.makedirs(OUT, exist_ok=True)
    write_index({name: build(name) for name in argv or list(CARS)})


main()
