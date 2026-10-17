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


# ===================================================================== kenney
#
# Built the way the toy-car kit builds its own cars (measured off the kit's
# bodies, not guessed):
#   * FLAT shading and no bevels: every edge is a hard edge, and the shape's
#     only softening is a big 45-degree cut written into its outline;
#   * dimensions on the kit's 1/16 grid; the kit's own wheels at x 0.1875,
#     radius and width 0.125, standing clear beside a narrow lower body,
#     with a wider shoulder over them;
#   * full-width dark bumper slabs 1/16 deep, wedged on top, at both ends;
#   * paint is ONE gradient band over the body's height; everything else is
#     the kit's dark steel, its slate (the windows, painted onto the cabin's
#     own faces), and white for the face of a side pod or a lamp;
#   * a paint spoiler slab on dark struts.
# "A little more detail" than the kit is a few more of the kit's OWN parts
# per car (a scoop, pipes, a roll bar, a roof rack), never a new kind of part.

U = 0.0625                  # the kit's grid
SLATE = TYRE                # the kit paints its windows in the tyre slate
LIGHT = CHROME              # and the face of a pod or lamp in this white
PINNED_LIGHT = (3, 9, 0.5)  # an engine's grey: the white pinned mid-gradient


def kit_wheel(r=0.125, w=0.125):
    """The kit's wheel meshes (left, right) scaled to radius r, width w:
    baked, not a node scale, since the renderer rewrites the wheel nodes'
    transforms."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KIT, 'vehicle-racer.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    left = next(o for o in new if o.name.startswith('wheel-fl')).data.copy()
    right = next(o for o in new if o.name.startswith('wheel-fr')).data.copy()
    for o in new:
        bpy.data.objects.remove(o)
    for me in (left, right):
        me.transform(Matrix.Diagonal((w / 0.125, r / 0.125, r / 0.125, 1)))
    return left, right


def wheel_set(xs=0.1875, front=(0.25, 0.125, 0.125), rear=(-0.25, 0.125, 0.125)):
    """Four kit wheels at +-xs: front/rear = (y, radius, width)."""
    out = []
    for tag_, (y, r, w) in (('f', front), ('b', rear)):
        left, right = kit_wheel(r, w)
        out.append((f'wheel-{tag_}l', left, (-xs, y, r)))
        out.append((f'wheel-{tag_}r', right, (xs, y, r)))
    return out


def paint(obj, dirn, swatch, **bounds):
    """Paint the faces of obj looking along dirn (within ~50 degrees) inside
    bounds (x=(lo, hi), y=..., z=...), flush: the faces are split along the
    bounds first. How the kit paints a window onto a cabin."""
    d = Vector(dirn).normalized()
    bm = bmesh.new()
    bm.from_mesh(obj.data)

    def facing(f):
        return f.normal.dot(d) > 0.6

    for axis, (lo, hi) in bounds.items():
        k = 'xyz'.index(axis)
        for cut in (lo, hi):
            faces = [f for f in bm.faces if facing(f)]
            geom = faces + list({e for f in faces for e in f.edges}) + list({v for f in faces for v in f.verts})
            co, no = [0.0] * 3, [0.0] * 3
            co[k], no[k] = cut, 1.0
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no)
            bm.normal_update()
    i = slot(obj, swatch)
    for f in bm.faces:
        c = f.calc_center_median()
        if facing(f) and all(lo < c['xyz'.index(a)] < hi for a, (lo, hi) in bounds.items()):
            f.material_index = i
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def pair(fn):
    """Call fn(s) for the left (s=-1) and right (s=+1) side."""
    for s in (-1, 1):
        fn(s)


def xs(s, a, b):
    """The x interval a..b (both >= 0) on side s, low end first."""
    return tuple(sorted((s * a, s * b)))


def bumpers(parts, front=0.4375, back=-0.4375, z=(0.0875, 0.2125), hx=0.25):
    """The kit's full-width dark slabs, 1/16 deep, wedged on their top."""
    z0, z1 = z
    for name, y, sg in (('fbump', front, 1), ('rbump', back, -1)):
        parts.append(profile(name, hx, [(y, z0), (y, z1 - U / 2), (y - sg * U / 2, z1), (y - sg * U, z1),
                                        (y - sg * U, z0)], STEEL, 0))


def pods(parts, y, P, z=(0.222, 0.297)):
    """The kit's side pods behind the front wheels, white on their face."""
    def one(s):
        parts.append(paint_face(box(f'pod{s}', (xs(s, 0.1875, 0.2625)[0], y - 0.0375, z[0]),
                                    (xs(s, 0.1875, 0.2625)[1], y + 0.0375, z[1]), P), 'y+', LIGHT))
    pair(one)


def lamps_on(obj, face, P_light, x, z):
    """A flush lamp pair painted on obj's `face` ('y+' front, 'y-' back) over
    |x| in x and z in z."""
    d = (0, 1, 0) if face == 'y+' else (0, -1, 0)
    for s in (-1, 1):
        paint(obj, d, P_light, x=xs(s, *x), z=z)


def cabin(parts, P, bottom, top, side_y, z, front_x, rear_x=None):
    """A tapered cabin with slate windows painted on its faces: the sides
    over side_y, the screen over |x| < front_x, the rear over |x| < rear_x."""
    c = taper('cabin', bottom, top, P, 0)
    for s in (-1, 1):
        paint(c, (s, 0, 0.2), SLATE, y=side_y, z=z)
    paint(c, (0, 1, 1), SLATE, x=(-front_x, front_x), z=z)
    if rear_x:
        paint(c, (0, -1, 1), SLATE, x=(-rear_x, rear_x), z=z)
    parts.append(c)
    return c


def spoiler(parts, P, y0, y1, z, hx=0.25, strut_x=0.125, strut_z0=0.3):
    """The kit's spoiler: a paint slab, raked, on two dark struts."""
    parts.append(profile('spoiler', hx, [(y0, z), (y1, z + 0.016), (y1, z + 0.047), (y0, z + 0.031)], P, 0))
    pair(lambda s: parts.append(box(f'strut{s}', (xs(s, strut_x, strut_x + 0.031)[0], y1 + 0.02, strut_z0),
                                    (xs(s, strut_x, strut_x + 0.031)[1], y0 - 0.02, z + 0.01), STEEL)))


def sprint():
    """A kit coupe with a little more: a bonnet scoop, a raked spoiler on
    struts, flush head and tail lamps, slate windows all round."""
    P = GREEN
    parts = []
    parts.append(box('lower', (-0.1875, -0.375, 0.0875), (0.1875, 0.375, 0.25), P))
    sh = profile('shoulder', 0.25, [(0.375, 0.25), (0.375, 0.28), (0.34, 0.3125), (-0.375, 0.3125),
                                    (-0.40625, 0.28), (-0.40625, 0.25)], P, 0)
    lamps_on(sh, 'y+', LIGHT, (0.125, 0.21), (0.255, 0.28))
    lamps_on(sh, 'y-', LAMP_RED, (0.125, 0.22), (0.255, 0.28))
    parts.append(sh)
    cabin(parts, P, (0.2, -0.28, 0.125, 0.3125), (0.15, -0.2, 0.0, 0.4375), (-0.18, 0.08), (0.33, 0.42), 0.12, 0.12)
    scoop = profile('scoop', U, [(0.28, 0.3125), (0.28, 0.345), (0.14, 0.355), (0.14, 0.3125)], P, 0)
    parts.append(paint_face(scoop, 'y+', STEEL))
    spoiler(parts, P, -0.3125, -0.4375, 0.375)
    bumpers(parts)
    pods(parts, 0.11, P)
    return join(parts, 'body'), wheel_set()


def formula():
    """A kit open-wheeler with a little more: side pods with dark intakes,
    an airbox behind a roll hoop, a front wing and a rear wing on struts."""
    P = RED
    parts = []
    pts = []
    for y, hx, z0, z1 in ((0.44, 0.0625, 0.0875, 0.15), (0.25, 0.1, 0.0875, 0.22), (0.0, 0.125, 0.0875, 0.28),
                          (-0.3125, 0.125, 0.0875, 0.28), (-0.4, 0.1, 0.0875, 0.25)):
        pts += [(s * hx, y, z) for s in (-1, 1) for z in (z0, z1)]
    tub = hull('tub', pts, P, 0)
    paint(tub, (0, 0, 1), STEEL, x=(-0.07, 0.07), y=(-0.14, 0.06))
    paint(tub, (0, -1, 0), LAMP_RED, x=(-0.035, 0.035), z=(0.16, 0.21))
    parts.append(tub)
    parts.append(box('hoop', (-0.0625, -0.19, 0.27), (0.0625, -0.14, 0.35), STEEL))
    air = profile('airbox', 0.047, [(-0.14, 0.27), (-0.14, 0.375), (-0.22, 0.375), (-0.33, 0.27)], P, 0)
    parts.append(paint_face(air, 'y+', STEEL))

    def sidepod(s):
        pod = profile(f'spod{s}', 0.04, [(0.09, 0.0875), (0.09, 0.2), (0.06, 0.235), (-0.13, 0.235),
                                         (-0.13, 0.0875)], P, 0, cx=s * 0.165)
        parts.append(paint_face(pod, 'y+', STEEL))
    pair(sidepod)
    parts.append(profile('fwing', 0.25, [(0.4375, 0.0625), (0.4375, 0.094), (0.375, 0.11), (0.375, 0.0625)], STEEL, 0))
    spoiler(parts, P, -0.3125, -0.4375, 0.34, strut_x=0.06, strut_z0=0.24)
    return join(parts, 'body'), wheel_set(0.2125, (0.25, 0.11, 0.1), (-0.28, 0.135, 0.14))


def rally():
    """A kit hatchback with a little more: a tall glasshouse, a roof scoop and
    roof spoiler, a pair of driving lamps on the front bumper."""
    P = BLUE
    parts = []
    parts.append(box('lower', (-0.1875, -0.375, 0.0875), (0.1875, 0.375, 0.25), P))
    sh = profile('shoulder', 0.25, [(0.375, 0.25), (0.375, 0.29), (0.34, 0.3125), (-0.375, 0.3125),
                                    (-0.375, 0.25)], P, 0)
    lamps_on(sh, 'y+', LIGHT, (0.13, 0.215), (0.26, 0.29))
    lamps_on(sh, 'y-', LAMP_RED, (0.15, 0.225), (0.26, 0.3))
    parts.append(sh)
    cabin(parts, P, (0.22, -0.375, 0.1, 0.3125), (0.18, -0.35, -0.03, 0.46875), (-0.32, 0.06), (0.33, 0.45),
          0.14, 0.15)
    parts.append(profile('rspoiler', 0.2, [(-0.29, 0.46875), (-0.4, 0.46), (-0.4, 0.49), (-0.29, 0.5)], P, 0))
    parts.append(paint_face(box('rscoop', (-0.05, -0.08, 0.46), (0.05, 0.0, 0.5), P), 'y+', STEEL))
    bumpers(parts)
    pair(lambda s: parts.append(paint_face(box(f'drive{s}', (xs(s, 0.05, 0.13)[0], 0.395, 0.2125),
                                                (xs(s, 0.05, 0.13)[1], 0.43, 0.27), STEEL), 'y+', LIGHT)))
    pods(parts, 0.08, P)
    return join(parts, 'body'), wheel_set()


def muscle():
    """A kit muscle car with a little more: a long bonnet with a grey blower
    and dark scoop through it, a set-back cab, a ducktail, side pipes and
    fatter rear wheels."""
    P = PURPLE
    parts = []
    parts.append(box('lower', (-0.1875, -0.375, 0.0875), (0.1875, 0.375, 0.25), P))
    sh = profile('shoulder', 0.25, [(0.375, 0.25), (0.375, 0.29), (0.3438, 0.3125), (-0.4375, 0.3125),
                                    (-0.4375, 0.25)], P, 0)
    lamps_on(sh, 'y+', LIGHT, (0.12, 0.21), (0.255, 0.285))
    lamps_on(sh, 'y-', LAMP_RED, (0.1, 0.22), (0.26, 0.29))
    parts.append(sh)
    cabin(parts, P, (0.21, -0.34, -0.02, 0.3125), (0.17, -0.28, -0.1, 0.4375), (-0.26, -0.06), (0.33, 0.42),
          0.13, 0.13)
    parts.append(box('blower', (-0.0625, 0.12, 0.3125), (0.0625, 0.28, 0.375), PINNED_LIGHT))
    parts.append(paint_face(box('hat', (-0.047, 0.16, 0.375), (0.047, 0.26, 0.42), STEEL), 'y+', INK))
    parts.append(profile('duck', 0.25, [(-0.36, 0.3125), (-0.4375, 0.35), (-0.4375, 0.3125)], P, 0))
    pair(lambda s: parts.append(box(f'pipe{s}', (xs(s, 0.19, 0.235)[0], -0.1, 0.0875),
                                    (xs(s, 0.19, 0.235)[1], 0.1, 0.125), PINNED_LIGHT)))
    bumpers(parts, back=-0.4375)
    pods(parts, 0.0, P)
    return join(parts, 'body'), wheel_set(front=(0.25, 0.125, 0.125), rear=(-0.25, 0.14, 0.145))


def pickup():
    """A kit pickup with a little more: an open bed with a crate in it, a roll
    bar with two lamps behind the cab."""
    P = ORANGE
    parts = []
    parts.append(box('lower', (-0.1875, -0.375, 0.0875), (0.1875, 0.375, 0.25), P))
    hood = profile('hood', 0.25, [(0.375, 0.25), (0.375, 0.29), (0.34, 0.3125), (0.0, 0.3125), (0.0, 0.25)], P, 0)
    lamps_on(hood, 'y+', LIGHT, (0.12, 0.21), (0.255, 0.285))
    parts.append(hood)
    cabin(parts, P, (0.235, -0.1, 0.12, 0.25), (0.2, -0.08, 0.04, 0.47), (-0.06, 0.07), (0.33, 0.45), 0.15, 0.15)
    parts.append(box('bedfloor', (-0.22, -0.4375, 0.25), (0.22, -0.1, 0.27), STEEL))
    pair(lambda s: parts.append(box(f'wall{s}', (xs(s, 0.205, 0.25)[0], -0.4375, 0.25),
                                    (xs(s, 0.205, 0.25)[1], -0.1, 0.34), P)))
    gate = box('gate', (-0.25, -0.4375, 0.25), (0.25, -0.4, 0.34), P)
    lamps_on(gate, 'y-', LAMP_RED, (0.15, 0.225), (0.275, 0.315))
    parts.append(gate)
    parts.append(box('crate', (-0.11, -0.34, 0.27), (0.05, -0.18, 0.37), TAN))
    pair(lambda s: parts.append(box(f'post{s}', (xs(s, 0.16, 0.19)[0], -0.14, 0.27),
                                    (xs(s, 0.16, 0.19)[1], -0.11, 0.48), STEEL)))
    parts.append(box('bar', (-0.19, -0.14, 0.48), (0.19, -0.11, 0.51), STEEL))
    pair(lambda s: parts.append(paint_face(box(f'spot{s}', (xs(s, 0.04, 0.11)[0], -0.11, 0.47),
                                                (xs(s, 0.04, 0.11)[1], -0.08, 0.52), STEEL), 'y+', LIGHT)))
    bumpers(parts)
    pods(parts, 0.105, P)
    return join(parts, 'body'), wheel_set()


def van():
    """A kit micro van with a little more: a tall box with a band of slate
    windows, a roof rack with a suitcase strapped on."""
    P = CREAM
    parts = []
    parts.append(box('lower', (-0.1875, -0.375, 0.0875), (0.1875, 0.375, 0.25), P))
    b = profile('van', 0.235, [(0.4, 0.25), (0.415, 0.33), (0.33, 0.49), (-0.39, 0.49), (-0.4, 0.25)], P, 0)
    for s in (-1, 1):
        for y in ((0.13, 0.27), (-0.1, 0.09), (-0.33, -0.14)):
            paint(b, (s, 0, 0), SLATE, y=y, z=(0.35, 0.45))
    paint(b, (0, 1, 0.5), SLATE, x=(-0.19, 0.19), z=(0.35, 0.465))
    paint(b, (0, -1, 0), SLATE, x=(-0.17, 0.17), z=(0.35, 0.45))
    lamps_on(b, 'y+', LIGHT, (0.12, 0.2), (0.27, 0.305))
    lamps_on(b, 'y-', LAMP_RED, (0.14, 0.21), (0.27, 0.32))
    parts.append(b)
    pair(lambda s: parts.append(box(f'rail{s}', (xs(s, 0.13, 0.16)[0], -0.3, 0.49),
                                    (xs(s, 0.13, 0.16)[1], 0.2, 0.52), STEEL)))
    parts.append(box('case', (-0.1, -0.2, 0.505), (0.08, 0.05, 0.57), TAN))
    bumpers(parts)
    pods(parts, 0.2, P, z=(0.255, 0.33))
    return join(parts, 'body'), wheel_set()


# name -> (builder, the roster car whose role it would take). The order is
# the gallery's.
CARS = {
    'kit-sprint': (sprint, 'vehicle-racer-low'),
    'kit-formula': (formula, 'vehicle-speedster'),
    'kit-rally': (rally, 'vehicle-racer'),
    'kit-muscle': (muscle, 'vehicle-vintage-racer'),
    'kit-pickup': (pickup, None),
    'kit-van': (van, None),
}


def build(name):
    fresh()
    body, wheels = CARS[name][0]()
    for p in body.data.polygons:
        p.use_smooth = False  # the kit's look: every face flat
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
