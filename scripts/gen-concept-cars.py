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
# A screen facing the sky catches it and washes out to white: pinned down
# the gradient (a third element pins any swatch's height) it reads as glass.
SKY_GLASS = (2, 13, 0.25)
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


def swatch_mat(swatch):
    if swatch not in SWATCHES:
        mat = bpy.data.materials.new('sw_' + '_'.join(map(str, swatch)))
        mat['swatch'] = list(swatch)
        SWATCHES[swatch] = mat
    return SWATCHES[swatch]


def slot(obj, swatch):
    """The index of obj's material slot for `swatch`, added if missing."""
    mats = obj.data.materials
    mat = swatch_mat(swatch)
    if mat.name not in mats:
        mats.append(mat)
    return mats.find(mat.name)


def tag(obj, swatch):
    """Give every face of obj the material slot standing for `swatch`."""
    obj.data.materials.clear()
    obj.data.materials.append(swatch_mat(swatch))
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
        row, col, *pin = mat['swatch']
        for li in p.loop_indices:
            z = me.vertices[me.loops[li].vertex_index].co.z
            t = pin[0] if pin else min(max((z - zlo) / span, 0.0), 1.0)
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
# One vocabulary across the set, Carve plus's: LAMPS front and back (tail
# lamps always a pair) and one HOOD detail. Wings stay plain — the roster's
# as the kit made them. Nothing else is added — no mirrors, side glass, pipes,
# roundels, canards or diffusers — so the extras stay few.
#
# Details are built THE KIT'S WAY. The kit has no fine detail at all: every
# part is a chunky block with one flat chamfer, coloured a whole face at a
# time, and its glass is only faces painted glass. So a lamp is a block
# standing out of the body in the lamp's colour, a grille a dark block, a
# scoop a block whose mouth face is dark, a window a patch of the body's own
# faces painted glass. Slots, round lenses and louvre stripes read as another
# kit's parts, and thin plates as stickers.

FACES = {'x+': (0, 1), 'x-': (0, -1), 'y+': (1, 1), 'y-': (1, -1), 'z+': (2, 1)}


def paint_face(obj, face, swatch):
    """Paint obj's faces pointing `face` in swatch, its chamfers keeping the
    rest's: how the kit colours a lamp's lens or a scoop's mouth."""
    axis, sign = FACES[face]
    i = slot(obj, swatch)
    for p in obj.data.polygons:
        if p.normal[axis] * sign > 0.9:
            p.material_index = i
    if 'bevel' in obj.modifiers:
        obj.modifiers['bevel'].material = 0
    return obj


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

    def block(self, name, face, rect, swatch, out=0.016, depth=0.03, lit=None):
        """A block over rect = (a0, a1, b0, b1) standing `out` proud of the
        face (found under rect's centre) with its back `depth` inside the
        body; `lit` paints only its outer face."""
        axis, sign = FACES[face]
        (a0, a1), (b0, b1) = sorted(rect[:2]), sorted(rect[2:])
        at = self.ray(face, (a0 + a1) / 2, (b0 + b1) / 2)[0][axis]
        lo, hi = [a0, b0], [a1, b1]
        lo.insert(axis, min(at - sign * depth, at + sign * out))
        hi.insert(axis, max(at - sign * depth, at + sign * out))
        obj = box(name, lo, hi, swatch, 0.006)
        return paint_face(obj, face, lit) if lit else obj

    def patch(self, body, face, rect, swatch):
        """Paint rect of the body's faces looking `face`, flush, the way the
        kit colours its glass: those faces are split along rect's edges and
        the ones inside it take swatch."""
        axis, sign = FACES[face]
        others = [i for i in range(3) if i != axis]
        bounds = list(zip(others, (sorted(rect[:2]), sorted(rect[2:]))))
        at = self.ray(face, sum(rect[:2]) / 2, sum(rect[2:]) / 2)[0][axis]
        bm = bmesh.new()
        bm.from_mesh(body.data)

        def under(f):
            if f.normal[axis] * sign < 0.5:
                return False
            return all(min(v.co[k] for v in f.verts) < hi and max(v.co[k] for v in f.verts) > lo
                       for k, (lo, hi) in bounds)

        for k, (lo, hi) in bounds:
            for cut in (lo, hi):
                faces = [f for f in bm.faces if under(f)]
                geom = faces + list({e for f in faces for e in f.edges}) + list({v for f in faces for v in f.verts})
                co, no = [0.0] * 3, [0.0] * 3
                co[k], no[k] = cut, 1.0
                bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no)
        i = slot(body, swatch)
        for f in bm.faces:
            c = f.calc_center_median()
            if under(f) and abs(c[axis] - at) < 0.02 and all(lo < c[k] < hi for k, (lo, hi) in bounds):
                f.material_index = i
        bm.to_mesh(body.data)
        bm.free()


def lamps(S, parts, name, face, xs, zs, swatch, **kw):
    """A left and right pair of S.block lamps over x in xs, z in zs."""
    for s in (-1, 1):
        parts.append(S.block(f'{name}{s}', face, (s * xs[0], s * xs[1], *zs), swatch, **kw))


def scoop(S, parts, y0, y1, hx, swatch, mouth=INK, rise=0.022):
    """A block following the bonnet from y0 forward to y1, its front face a
    dark mouth (a scoop) or, with no mouth, the paint (a bulge)."""
    h0, h1 = S.height(0, y0), S.height(0, y1)
    obj = profile('scoop', hx, [(y1, h1 - 0.01), (y1, h1 + rise), (y0 + 0.03, h0 + rise), (y0, h0 - 0.01)],
                  swatch, 0.008)
    parts.append(paint_face(obj, 'y+', mouth) if mouth else obj)


def shell(parts):
    """Join the shell built so far, with a Surface to seat details on it."""
    body = join(parts, 'body')
    return body, Surface(body), [body]



def side_pillar(name, s, a, b, swatch, inset=0.03):
    """A window pillar on side s: a band over the cabin's side from the belt
    point a=(x, y, z) to the roof point b, `inset` deep into the glass."""
    pts = []
    for x, y, z in (a, b):
        for dy in (-0.018, 0.018):
            pts += [(s * (x + 0.003), y + dy, z), (s * (x - inset), y + dy, z)]
    return hull(name, pts, swatch, 0)


def mirrored_pair(obj):
    """The left-side twin of a right wheel object's mesh (hubcap facing -x)."""
    me = obj.data.copy()
    me.transform(Matrix.Scale(-1, 4, (1, 0, 0)))
    me.flip_normals()
    return me


# ======================================================================= toys
#
# What makes these read as TOYS rather than scale models, shared by the set:
#   * chibi proportions: fat wheels, short overhangs, an oversized cabin;
#   * a die-cast's two pieces: a painted shell sitting on a dark chassis tray
#     whose ends are chunky steel bumpers;
#   * fat tyres with a big light hubcap (chrome, the swatch the seat marks
#     tint on a player's car, inside their 0.062 rim circle);
#   * fenders that bulge out over the wheels.
# Each car then owns ONE silhouette, judged from the chase camera (behind and
# above): what it sees is the roof, the rear deck and the tail face.


def toy_wheel(name, r, w, knobs=0):
    """A fat toy tyre with chamfered shoulders and a big hubcap on its +x
    face; `knobs` adds chunky tread blocks round the tread."""
    pts = []
    seg = 10
    for x, rr in ((-w / 2, r * 0.78), (-w / 2 + w * 0.2, r), (w / 2 - w * 0.2, r), (w / 2, r * 0.78)):
        for i in range(seg):
            a = 2 * math.pi * (i + 0.5) / seg
            pts.append((x, rr * math.cos(a), rr * math.sin(a)))
    parts = [hull(f"{name}-tyre", pts, TYRE, 0, angle=40)]
    if knobs:
        rr = r * 0.9
        for i in range(knobs):
            a = 2 * math.pi * i / knobs
            ca, sa = math.cos(a), math.sin(a)
            hw = r * 0.17
            kp = [(x, q * sa + t * ca, q * ca - t * sa)
                  for q in (rr, r * 1.07) for t in (-hw, hw) for x in (-w * 0.42, w * 0.42)]
            parts.append(hull(f"{name}-knob{i}", kp, TYRE, 0))
    parts.append(disc(f"{name}-cap", (w / 2 - 0.006, 0, 0), (1, 0, 0), min(r * 0.56, 0.07), 0.014, CHROME, 10))
    parts.append(disc(f"{name}-hub", (w / 2 + 0.006, 0, 0), (1, 0, 0), r * 0.17, 0.012, TYRE, 6))
    w_obj = join(parts, name)
    paint_uvs(w_obj)
    return w_obj


def wheel_set(xs, front, rear):
    """Four wheels: front/rear = (y, toy_wheel object, radius)."""
    out = []
    for tag_, (y, obj, r) in (('f', front), ('b', rear)):
        out.append((f'wheel-{tag_}l', mirrored_pair(obj), (-xs, y, r)))
        out.append((f'wheel-{tag_}r', obj.data, (xs, y, r)))
    return out


def tray(parts, hx, y0, y1, bump_hx, z=(0.06, 0.12), bz=(0.075, 0.155), bd=0.06, swatch=STEEL):
    """The die-cast's chassis: a dark tray under the shell, a chunky steel
    bumper at either end."""
    parts.append(box('tray', (-hx, y0 + bd * 0.5, z[0]), (hx, y1 - bd * 0.5, z[1]), CHARCOAL))
    parts.append(box('fbump', (-bump_hx, y1 - bd, bz[0]), (bump_hx, y1, bz[1]), swatch, 0.018))
    parts.append(box('rbump', (-bump_hx, y0, bz[0]), (bump_hx, y0 + bd, bz[1]), swatch, 0.018))


def arch(name, s, y, cx, hx, r, swatch, top=None, z0=0.11, bev=0.022):
    """A fender bulging out over the wheel at y: a rounded arch profile
    centred on x = s*cx, `hx` thick."""
    t = top if top is not None else 2 * r + 0.012
    reach = r * 1.15
    side = [(y + reach, z0), (y + reach * 0.85, t - 0.05), (y + reach * 0.45, t), (y - reach * 0.45, t),
            (y - reach * 0.85, t - 0.05), (y - reach, z0)]
    return profile(name, hx, side, swatch, bev, cx=s * cx)


def greenhouse(parts, P, bottom, top, roof_t=0.022, pillars=(), bev=0.012):
    """An oversized glass cabin with a painted roof cap and pillar bands.
    bottom/top = (halfX, yBack, yFront, z) as taper(); pillars = y pairs
    (y at the belt, y at the roof) for each band."""
    parts.append(taper('glass', bottom, top, GLASS, 0.01))
    hx, yb, yf, z = top
    parts.append(taper('roof', (hx + 0.006, yb - 0.008, yf + 0.008, z - 0.004),
                       (hx - 0.004, yb + 0.004, yf - 0.004, z + roof_t), P, bev))
    for i, (ya, yr) in enumerate(pillars):
        for s in (-1, 1):
            parts.append(side_pillar(f'pil{i}{s}', s, (bottom[0], ya, bottom[3] + 0.004),
                                     (top[0], yr, top[3] - 0.004), P))


def bumper_car():
    """The classic toy coupe: round-shouldered shell on a dark tray, a big
    glass cabin, fat fenders, a ducktail, steel bumpers and block lamps."""
    P = GREEN
    parts = []
    tray(parts, 0.17, -0.44, 0.44, 0.215)
    parts.append(profile('shell', 0.2, [(0.41, 0.11), (0.42, 0.2), (0.37, 0.245), (0.12, 0.262), (-0.3, 0.27),
                                        (-0.41, 0.25), (-0.42, 0.11)], P, 0.035))
    for s in (-1, 1):
        for y in (0.25, -0.25):
            parts.append(arch(f'arch{s}{y}', s, y, 0.205, 0.045, 0.13, P))
    greenhouse(parts, P, (0.17, -0.27, 0.12, 0.255), (0.14, -0.21, 0.02, 0.395),
               pillars=((0.115, 0.02), (-0.075, -0.075), (-0.262, -0.205)))
    parts.append(profile('duck', 0.185, [(-0.32, 0.262), (-0.43, 0.3), (-0.445, 0.29), (-0.43, 0.24)], P, 0.012))
    body, S, parts = shell(parts)
    lamps(S, parts, 'head', 'y+', (0.1, 0.17), (0.17, 0.22), WHITE)
    parts.append(S.block('grille', 'y+', (-0.07, 0.07, 0.165, 0.215), INK, out=0.01))
    lamps(S, parts, 'tail', 'y-', (0.09, 0.165), (0.18, 0.225), LAMP_RED)
    w = toy_wheel('w', 0.13, 0.1)
    return join(parts, 'body'), wheel_set(0.19, (0.25, w, 0.13), (-0.25, w, 0.13))


def comet():
    """A land-speed streamliner: a long teardrop on a dark keel, a glass
    bubble, a tall tail fin, fat pods over big rear wheels and small front
    wheels out on their own."""
    P = RED
    parts = []
    parts.append(box('keel', (-0.12, -0.42, 0.06), (0.12, 0.40, 0.11), CHARCOAL, 0.01))
    pts = []
    for y, hx, z0, z1 in ((0.47, 0.06, 0.09, 0.13), (0.3, 0.13, 0.085, 0.2), (0.02, 0.17, 0.085, 0.26),
                          (-0.3, 0.17, 0.085, 0.255), (-0.45, 0.13, 0.09, 0.22)):
        pts += [(s * hx, y, z) for s in (-1, 1) for z in (z0, z1)]
    parts.append(hull('hull', pts, P, 0.03))
    for s in (-1, 1):
        parts.append(arch(f'pod{s}', s, -0.24, 0.2, 0.06, 0.145, P, top=0.29))
        parts.append(arch(f'cyc{s}', s, 0.27, 0.19, 0.04, 0.11, P, top=0.245, z0=0.17))
        x0, x1 = sorted((s * 0.11, s * 0.17))
        parts.append(box(f'arm{s}', (x0, 0.24, 0.1), (x1, 0.3, 0.13), CHARCOAL))
    parts.append(hull('bubble', [(s * hx, y, z) for s in (-1, 1) for y, hx, z in
                                 ((0.2, 0.06, 0.23), (0.12, 0.1, 0.3), (-0.02, 0.1, 0.33), (-0.12, 0.08, 0.32),
                                  (-0.18, 0.06, 0.255))], GLASS, 0.02))
    parts.append(profile('fin', 0.018, [(-0.12, 0.25), (-0.38, 0.43), (-0.455, 0.43), (-0.455, 0.22)], P, 0.012))
    body, S, parts = shell(parts)
    lamps(S, parts, 'head', 'y+', (0.025, 0.06), (0.1, 0.125), WHITE, out=0.01)
    lamps(S, parts, 'tail', 'y-', (0.045, 0.11), (0.15, 0.19), LAMP_RED, out=0.02)
    parts.append(S.block('jet', 'y-', (-0.04, 0.04, 0.11, 0.16), INK, out=0.012))
    wf = toy_wheel('wf', 0.11, 0.08)
    wr = toy_wheel('wr', 0.145, 0.12)
    return join(parts, 'body'), wheel_set(0.205, (0.27, wf, 0.11), (-0.24, wr, 0.145))


def scout():
    """A stubby rally scout on chunky tread: a tall boxy shell, dark flares,
    a roof light bar and the spare wheel strapped on its tail."""
    P = BLUE
    parts = []
    tray(parts, 0.17, -0.4, 0.42, 0.215, bz=(0.07, 0.17), bd=0.07)
    parts.append(profile('shell', 0.195, [(0.37, 0.12), (0.38, 0.235), (0.31, 0.27), (-0.36, 0.28),
                                         (-0.375, 0.265), (-0.375, 0.12)], P, 0.03))
    for s in (-1, 1):
        for y in (0.24, -0.23):
            parts.append(arch(f'flare{s}{y}', s, y, 0.205, 0.05, 0.14, CHARCOAL, top=0.27, bev=0.016))
    greenhouse(parts, P, (0.175, -0.355, 0.11, 0.27), (0.16, -0.34, 0.0, 0.42), roof_t=0.02,
               pillars=((0.095, 0.0), (-0.12, -0.12), (-0.34, -0.325)))
    parts.append(box('lightbar', (-0.13, -0.02, 0.44), (0.13, 0.05, 0.48), CHARCOAL, 0.01))
    for s in (-1, 1):
        parts.append(box(f'barfoot{s}', (s * 0.11 - 0.012, 0.0, 0.43), (s * 0.11 + 0.012, 0.03, 0.445), CHARCOAL))
    body, S, parts = shell(parts)
    for i, x in enumerate((-0.1, -0.035, 0.035, 0.1)):
        parts.append(paint_face(box(f'spot{i}', (x - 0.026, 0.045, 0.445), (x + 0.026, 0.06, 0.475), WHITE, 0.004),
                                'y-', CHARCOAL))
    lamps(S, parts, 'head', 'y+', (0.1, 0.17), (0.185, 0.235), WHITE)
    parts.append(S.block('grille', 'y+', (-0.07, 0.07, 0.18, 0.24), INK, out=0.01))
    lamps(S, parts, 'tail', 'y-', (0.145, 0.185), (0.17, 0.25), LAMP_RED, out=0.016)
    spare = toy_wheel('spare', 0.095, 0.06, knobs=8)
    spare.data.transform(Matrix.Rotation(math.radians(-90), 4, 'Z'))
    spare.location = (0, -0.408, 0.235)
    # the body's UVs are painted after the join: one layer, not the wheel's
    spare.data.uv_layers.remove(spare.data.uv_layers[0])
    w = toy_wheel('w', 0.14, 0.115, knobs=9)
    body = join(parts + [spare], 'body')
    return body, wheel_set(0.195, (0.24, w, 0.14), (-0.23, w, 0.14))


def brute():
    """A toy hot rod: a narrow nose on skinny front wheels, a chrome blower
    through the bonnet, a chopped cab, and huge slicks under fat fenders."""
    P = PURPLE
    parts = []
    parts.append(box('frame', (-0.1, -0.42, 0.065), (0.1, 0.42, 0.12), CHARCOAL, 0.01))
    pts = []
    for y, hx, z0, z1 in ((0.43, 0.11, 0.1, 0.215), (0.05, 0.135, 0.09, 0.255), (-0.1, 0.18, 0.09, 0.27),
                          (-0.43, 0.18, 0.09, 0.265)):
        pts += [(s * hx, y, z) for s in (-1, 1) for z in (z0, z1)]
    parts.append(hull('body', pts, P, 0.028))
    parts.append(box('rbump', (-0.2, -0.47, 0.08), (0.2, -0.41, 0.15), STEEL, 0.018))
    for s in (-1, 1):
        parts.append(arch(f'fender{s}', s, -0.25, 0.205, 0.07, 0.155, P, top=0.33))
        parts.append(box(f'axle{s}', (min(s * 0.09, s * 0.16), 0.25, 0.09), (max(s * 0.09, s * 0.16), 0.29, 0.12),
                         CHARCOAL))
    parts.append(box('grille', (-0.085, 0.43, 0.09), (0.085, 0.465, 0.24), CHROME, 0.012))
    parts.append(box('blower', (-0.075, 0.1, 0.22), (0.075, 0.3, 0.31), CHROME, 0.016))
    parts.append(paint_face(box('hat', (-0.055, 0.15, 0.3), (0.055, 0.28, 0.36), CHARCOAL, 0.01), 'y+', INK))
    greenhouse(parts, P, (0.165, -0.3, -0.04, 0.27), (0.15, -0.27, -0.1, 0.37), roof_t=0.022,
               pillars=((-0.055, -0.11), (-0.282, -0.255)))
    body, S, parts = shell(parts)
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.1, s * 0.155))
        parts.append(paint_face(box(f'lamp{s}', (x0, 0.39, 0.2), (x1, 0.45, 0.255), CHROME, 0.01), 'y+', WHITE))
    lamps(S, parts, 'tail', 'y-', (0.1, 0.165), (0.19, 0.24), LAMP_RED)
    wf = toy_wheel('wf', 0.1, 0.075)
    wr = toy_wheel('wr', 0.155, 0.14)
    return join(parts, 'body'), wheel_set(0.205, (0.27, wf, 0.1), (-0.25, wr, 0.155))


def hauler():
    """A toy pickup: a short cab over a chunky nose, an open bed with a crate
    in it, a roll bar with lamps behind the cab, big steel bumpers."""
    P = ORANGE
    parts = []
    tray(parts, 0.17, -0.44, 0.44, 0.22, bz=(0.07, 0.165), bd=0.065)
    parts.append(profile('nose', 0.2, [(0.42, 0.11), (0.425, 0.235), (0.37, 0.265), (0.1, 0.275), (0.1, 0.11)],
                         P, 0.032))
    parts.append(box('cab', (-0.2, -0.08, 0.11), (0.2, 0.12, 0.275), P, 0.03))
    greenhouse(parts, P, (0.18, -0.08, 0.13, 0.27), (0.165, -0.075, 0.06, 0.41), roof_t=0.022)
    parts.append(box('bed', (-0.2, -0.42, 0.11), (0.2, -0.08, 0.17), CHARCOAL, 0.012))
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.155, s * 0.2))
        parts.append(box(f'wall{s}', (x0, -0.42, 0.15), (x1, -0.07, 0.27), P, 0.016))
    parts.append(box('gate', (-0.2, -0.43, 0.15), (0.2, -0.385, 0.265), P, 0.016))
    parts.append(box('crate', (-0.1, -0.33, 0.16), (0.06, -0.17, 0.27), TAN, 0.012))
    for s in (-1, 1):
        for y in (0.25, -0.25):
            parts.append(arch(f'arch{s}{y}', s, y, 0.21, 0.04, 0.135, P, top=0.285))
    for s in (-1, 1):
        parts.append(box(f'post{s}', (s * 0.16 - 0.016, -0.115, 0.26), (s * 0.16 + 0.016, -0.085, 0.43), CHARCOAL))
    parts.append(box('rollbar', (-0.18, -0.12, 0.42), (0.18, -0.08, 0.455), CHARCOAL, 0.008))
    body, S, parts = shell(parts)
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.04, s * 0.11))
        parts.append(paint_face(box(f'spot{s}', (x0, -0.085, 0.42), (x1, -0.06, 0.47), CHARCOAL, 0.006), 'y+', WHITE))
    lamps(S, parts, 'head', 'y+', (0.11, 0.175), (0.18, 0.23), WHITE)
    parts.append(S.block('grille', 'y+', (-0.08, 0.08, 0.165, 0.235), INK, out=0.01))
    lamps(S, parts, 'tail', 'y-', (0.13, 0.185), (0.2, 0.25), LAMP_RED, out=0.014)
    w = toy_wheel('w', 0.135, 0.11)
    return join(parts, 'body'), wheel_set(0.195, (0.25, w, 0.135), (-0.25, w, 0.135))


def bug():
    """A round toy bug: a domed shell, four fat round fenders with the
    headlamps in the front pair, running boards and a tiny rear screen."""
    P = GOLD
    parts = []
    tray(parts, 0.15, -0.42, 0.42, 0.19, bz=(0.08, 0.14), bd=0.05)
    parts.append(profile('shell', 0.165, [(0.39, 0.1), (0.41, 0.16), (0.37, 0.215), (0.22, 0.255),
                                          (-0.3, 0.27), (-0.39, 0.235), (-0.41, 0.17), (-0.39, 0.1)], P, 0.04))
    parts.append(profile('dome', 0.15, [(0.2, 0.25), (0.1, 0.35), (0.0, 0.395), (-0.13, 0.4), (-0.25, 0.37),
                                        (-0.32, 0.31), (-0.32, 0.25)], GLASS, 0.035))
    parts.append(profile('cap', 0.12, [(0.07, 0.37), (0.0, 0.405), (-0.13, 0.41), (-0.25, 0.375), (-0.27, 0.36)],
                         P, 0.02))
    for s in (-1, 1):
        parts.append(side_pillar(f'bp{s}', s, (0.15, -0.05, 0.27), (0.13, -0.06, 0.395), P))
        parts.append(profile(f'cpil{s}', 0.02, [(-0.2, 0.26), (-0.2, 0.37), (-0.32, 0.3), (-0.32, 0.26)], P, 0.0,
                             cx=s * 0.13))
    for s in (-1, 1):
        for y in (0.25, -0.25):
            parts.append(arch(f'fender{s}{y}', s, y, 0.19, 0.06, 0.13, P, top=0.29, bev=0.03))
        x0, x1 = sorted((s * 0.15, s * 0.225))
        parts.append(box(f'board{s}', (x0, -0.12, 0.095), (x1, 0.12, 0.125), STEEL, 0.01))
    body, S, parts = shell(parts)
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.165, s * 0.225))
        parts.append(paint_face(box(f'eye{s}', (x0, 0.335, 0.225), (x1, 0.39, 0.275), CHROME, 0.012), 'y+', WHITE))
    parts.append(S.block('vent', 'y-', (-0.06, 0.06, 0.19, 0.23), INK, out=0.01))
    lamps(S, parts, 'tail', 'y-', (0.085, 0.145), (0.165, 0.215), LAMP_RED)
    w = toy_wheel('w', 0.125, 0.1)
    return join(parts, 'body'), wheel_set(0.19, (0.25, w, 0.125), (-0.25, w, 0.125))


# name -> (builder, the roster car whose role it would take). The order is
# the gallery's.
CARS = {
    'toy-bumper': (bumper_car, 'vehicle-racer-low'),
    'toy-comet': (comet, 'vehicle-speedster'),
    'toy-scout': (scout, 'vehicle-racer'),
    'toy-brute': (brute, 'vehicle-vintage-racer'),
    'toy-hauler': (hauler, None),
    'toy-bug': (bug, None),
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
