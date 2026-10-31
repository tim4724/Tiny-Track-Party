# set_prototypes.py — the per-track landmarks, built in headless Blender:
# procedural primitives (there is no kit model for a ski lift or a slinky) with
# Kenney kit pieces imported where one fits. The primitives speak the grammar
# the game's cars are built in (scripts/toy_cars.py): chunky blocks with one
# small chamfer on every edge (chamfer), a pole, rail or rope is a square bar
# (BAR), the kit's palette with one gradient over the whole piece, light on top
# (paint, shade). Only what is round in life stays round: drums, wheels,
# canopies. One GLB per piece, in the set-piece
# frame the renderer places (gen-set-pieces.mjs: origin at the spot, +Z along the
# track's direction of travel, +X across, y = 0 the ground). The FRONT of a piece
# faces +X: placed on the track's right (lat > 0) at yaw 0 that is the road side,
# on the left use yaw 180.
#
# Each track has a HERO piece (its landmark proper) and a SUPPORT piece (a
# smaller second scene elsewhere on the lap); both are listed in the track's
# `set` in tracks.js. Every builder authors at a toy scale a car can be stood
# against (a car is ~1.8 long, the road 5 wide) and GROW scales the whole piece
# at export, so a landmark reads from the chase cam at the far side of a lap.
#
# Driven by scripts/gen-set-prototypes.mjs, which grafts each kit's atlas back
# onto the `tex:<kit>` materials this leaves (Blender's exporter writes no images
# here) and stages the result under public/assets/toycar.
#
#   blender -b -P scripts/blender/set_prototypes.py -- <kitCache> <outDir> [name ...]
#
# Blender is Z-up and the exporter maps (x, y, z) -> (x, z, -y), so every helper
# takes glTF coordinates (across, up, along) and converts once, in `P()`.
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
KIT_CACHE, OUT_DIR = argv[0], argv[1]
ONLY = set(argv[2:])

# ---- frame + colour -----------------------------------------------------------

def P(x, y, z):
    """glTF (across, up, along) -> Blender (x, y, z)."""
    return Vector((x, -z, y))

# Kenney colours its kits from one small atlas (the toy-car kit's
# Textures/colormap.png): a row of swatches, each a flat half and a RAMP half
# that darkens from top to bottom. A procedural part takes the swatch nearest
# the colour its builder asked for, and shade() runs the whole piece down the
# ramp by height, light on top, as the cars are. The swatch is (x, y) of its
# top-left pixel in the 128 px atlas; the ramp is x + 8 .. x + 15.
SWATCH = {
    'cream': (0, 64), 'green': (16, 64), 'yellow': (32, 64), 'orange': (48, 64),
    'red': (64, 64), 'blue': (80, 64), 'sky': (96, 64), 'purple': (112, 64),
    'dark': (0, 96), 'grey': (16, 96), 'slate': (32, 96), 'lavender': (48, 96),
    'white': (64, 96), 'salmon': (80, 96), 'brown': (96, 96), 'tan': (112, 96),
    'pink': (0, 32),
}
SWATCH_RGB = {
    'cream': 0xfde4c7, 'green': 0x61cb8b, 'yellow': 0xffc044, 'orange': 0xff7e44,
    'red': 0xcf534f, 'blue': 0x6794d9, 'sky': 0xd0e8ff, 'purple': 0xa878e8,
    'dark': 0x38383d, 'grey': 0x868ba1, 'slate': 0x4f5260, 'lavender': 0xa0a8c9,
    'white': 0xffffff, 'salmon': 0xf1976c, 'brown': 0xb06041, 'tan': 0xf2bf99,
    'pink': 0xf378f0,
}
# where the nearest swatch reads wrong: water is blue, snow is white, glass is sky
SNAP = {0x62d3c8: 'sky', 0x8ecae6: 'sky', 0x7db8e8: 'blue', 0xe9eff6: 'white',
        0xd9b054: 'yellow', 0x6e5b3a: 'brown', 0x7d6f5f: 'grey', 0xb8a686: 'tan',
        0xcbb794: 'cream'}

def snap(color):
    """A swatch name, or the swatch nearest a hex colour (redmean distance)."""
    if isinstance(color, str):
        return color
    if color in SNAP:
        return SNAP[color]
    def d(k):
        a, b = color, SWATCH_RGB[k]
        r1, g1, b1, r2, g2, b2 = a >> 16 & 255, a >> 8 & 255, a & 255, b >> 16 & 255, b >> 8 & 255, b & 255
        rm = (r1 + r2) / 2
        return (2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2
    return min(SWATCH_RGB, key=d)

ATLAS = 'tex:toy-car'   # the driver grafts the kit's colormap onto this name
RAMP = 20   # px of the 32 px ramp a piece spans: the full run greys a white wall

def atlas_material():
    m = bpy.data.materials.get(ATLAS)
    if m is None:
        m = bpy.data.materials.new(ATLAS)
        m.use_nodes = True
    return m

def paint(obj, color):
    """Give `obj` the atlas and its swatch; shade() maps it once the piece stands."""
    me = obj.data
    me.materials.clear()
    me.materials.append(atlas_material())
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    obj['swatch'] = snap(color)
    return obj

def shade():
    """Every painted part down its swatch's ramp by WORLD height over the whole
    piece, as a car is shaded over the car: the roof light, the plinth dark.
    A UV that depends on the vertex alone also lets the chamfer share it.
    A part marked `ramp` (snowy()) runs only that share of it: lying snow
    greyed to lavender at the foot of a tall piece reads as stone."""
    bpy.context.view_layer.update()
    parts = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('swatch')]
    if not parts:
        return
    top = max(max((o.matrix_world @ v.co).z for v in o.data.vertices) for o in parts) or 1.0
    for o in parts:
        me, (x, y) = o.data, SWATCH[o['swatch']]
        uv, k = me.uv_layers[0], o.get('ramp', 1.0)
        for loop in me.loops:
            f = max(0.0, min(1.0, (o.matrix_world @ me.vertices[loop.vertex_index].co).z / top))
            uv.data[loop.index].uv = ((x + 12) / 128, 1 - (y + 0.5 + (1 - f) * RAMP * k) / 128)

# ---- primitives (glTF frame) ---------------------------------------------------

def place(obj, at, yaw=0.0, pitch=0.0, roll=0.0):
    obj.location = P(*at)
    # yaw about up (= Blender Z, same sign); pitch tips the +Z (along) axis up,
    # a rotation about Blender X by -pitch; roll tips +X up, about Blender Y.
    obj.rotation_euler = (-pitch, roll, yaw)
    return obj

# Nothing thinner than MIN_T (a plate, a stripe); a pole, a rail, a rung or a
# rope is a square bar at least BAR across, the cars' "no thin rods" at this
# scale: a car's bars are an eighth of its body's width, so a landmark's are
# fatter than the car's own.
MIN_T = 0.06
BAR = 0.2

def box(size, at, color, yaw=0.0, pitch=0.0, roll=0.0):
    """size = (across, up, along), centred at `at`."""
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    o = bpy.context.active_object
    size = [max(s, MIN_T) for s in size]
    o.scale = (size[0], size[2], size[1])
    o['chamfer'] = 1
    place(o, at, yaw, pitch, roll)
    return paint(o, color)

def cyl(r, h, at, color, r2=None, segs=8, axis='up', yaw=0.0, smooth=False):
    """A cylinder (or cone when r2 differs) whose base centre is `at`, standing
    along `axis` (up | along | across). Faceted, like a Kenney barrel; a thin
    one longer than four radii is a pole, built as the cars' square bar (a log
    or a trunk stays round)."""
    pole = h > 4 * r and r <= 0.25
    if pole:
        # a square of side 2r has its corners at r * sqrt(2)
        r = max(r, BAR / 2) * math.sqrt(2)
        r2 = None if r2 is None else max(r2, BAR / 3) * math.sqrt(2)
        segs, smooth = 4, False
    bpy.ops.mesh.primitive_cone_add(vertices=segs, radius1=r, radius2=r if r2 is None else r2,
                                    depth=h, end_fill_type='NGON')
    o = bpy.context.active_object
    for v in o.data.vertices:
        v.co.z += h / 2
        if pole:
            v.co.x, v.co.y = (v.co.x - v.co.y) / math.sqrt(2), (v.co.x + v.co.y) / math.sqrt(2)
    if pole:
        o['chamfer'] = 1
    if axis == 'along':
        o.rotation_euler = (math.radians(90), 0, 0)   # local Z -> Blender -Y (glTF +Z)
    elif axis == 'across':
        o.rotation_euler = (0, math.radians(90), 0)   # local Z -> Blender +X
    o.location = P(*at)
    if yaw:
        o.rotation_euler.z += yaw
    if smooth:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    return paint(o, color)

def tilted(obj, tx, ty):
    """Tip an up-standing object: tx about Blender X, ty about Blender Y."""
    obj.rotation_euler = (tx, ty, obj.rotation_euler.z)
    return obj

def sphere(r, at, color, subdiv=1, scale=(1, 1, 1), flat=True, yaw=0.0):
    # Faceted, as Kenney's are, but a flat face costs three vertices of its
    # own: nothing goes past one split, and a knob or an eye is a block, as
    # a car's lamp is.
    if flat and r * max(scale) < 0.35:
        return box([1.6 * r * k for k in scale], at, color, yaw=yaw)
    if flat:
        subdiv = min(subdiv, 1)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=r)
    o = bpy.context.active_object
    o.scale = (scale[0], scale[2], scale[1])
    o.location = P(*at)
    o.rotation_euler = (0, 0, yaw)
    if flat:
        bpy.ops.object.shade_flat()
    else:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    return paint(o, color)

def torus(R, r, at, color, segs=12, minor=6, axis='up', yaw=0.0):
    """A ring; a thin one is the cars' square bar bent round."""
    if r <= 0.25:
        r, minor = max(r, BAR / 2) * math.sqrt(2), 4
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=segs, minor_segments=minor)
    o = bpy.context.active_object
    if axis == 'along':
        o.rotation_euler = (math.radians(90), 0, 0)
    elif axis == 'across':
        o.rotation_euler = (0, math.radians(90), 0)
    o.location = P(*at)
    o.rotation_euler.z += yaw
    bpy.ops.object.shade_flat()
    return paint(o, color)

def disc(r, at, color, segs=24, h=0.04):
    return cyl(r, h, at, color, segs=segs, smooth=False)

def terrain(height, x0, x1, nx, z0, z1, nz, color):
    """A faceted heightfield (a hill, a bank): `height(x, z)` sampled on an
    nx-by-nz grid in the piece frame. Flat faces, no chamfer, like the kit's
    own snow and rock."""
    xs = [x0 + (x1 - x0) * i / (nx - 1) for i in range(nx)]
    zs = [z0 + (z1 - z0) * j / (nz - 1) for j in range(nz)]
    verts = [P(x, height(x, z), z) for z in zs for x in xs]
    faces = [(j * nx + i, j * nx + i + 1, (j + 1) * nx + i + 1, (j + 1) * nx + i)
             for j in range(nz - 1) for i in range(nx - 1)]
    me = bpy.data.meshes.new('terrain')
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    if me.polygons[0].normal.z < 0:
        for p in me.polygons:
            p.flip()
    o = bpy.data.objects.new('terrain', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def poly(verts, faces, color):
    """Raw faces in the piece frame (a fold of paper, a fin), each drawn from
    both sides so a thin sheet never vanishes from behind."""
    me = bpy.data.meshes.new('poly')
    faces = list(faces) + [tuple(reversed(f)) for f in faces]
    me.from_pydata([tuple(P(*v)) for v in verts], [], faces)
    me.update()
    o = bpy.data.objects.new('poly', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def prism(outline, x, t, color):
    """A flat board cut to `outline` [(z, y), ...] (counter-clockwise seen from
    +X), `t` thick, centred on `x`: a surfboard, a sign cut to shape."""
    n = len(outline)
    verts = [(x + t / 2, y, z) for z, y in outline] + [(x - t / 2, y, z) for z, y in outline]
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    faces += [(i, n + i, n + (i + 1) % n, (i + 1) % n) for i in range(n)]
    me = bpy.data.meshes.new('prism')
    me.from_pydata([tuple(P(*v)) for v in verts], [], faces)
    me.update()
    o = bpy.data.objects.new('prism', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def tube(points, r, color, res=4, bevel_res=1, closed=False, smooth=False, wire=False):
    """A bar swept along a smooth curve through glTF `points`: a thin one is
    square in section (a rope, a hose) unless `smooth` keeps it round; a trunk
    stays round. A `wire` (a telegraph wire, a lift cable) keeps its own thin
    radius: at the BAR floor it reads as a pipe."""
    if not wire:
        r = max(r, BAR / 2)
    if not smooth and r <= 0.25:
        r, bevel_res = r * math.sqrt(2), 0
    curve = bpy.data.curves.new('tube', 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = res
    curve.bevel_depth = r
    curve.bevel_resolution = bevel_res
    curve.use_fill_caps = True
    sp = curve.splines.new('NURBS')
    sp.points.add(len(points) - 1)
    for p, (x, y, z) in zip(sp.points, points):
        b = P(x, y, z)
        p.co = (b.x, b.y, b.z, 1.0)
    sp.use_endpoint_u = True
    sp.order_u = min(4, len(points))
    sp.use_cyclic_u = closed
    o = bpy.data.objects.new('tube', curve)
    bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.convert(target='MESH')
    o = bpy.context.active_object
    if smooth:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    else:
        bpy.ops.object.shade_flat()
    return paint(o, color)

def sag(a, b, drop, n=9):
    """Points of a sagging line from glTF point a to b."""
    pts = []
    for i in range(n):
        t = i / (n - 1)
        pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - drop * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t))
    return pts

def kit(kit_id, model, at, yaw=0.0, scale=1.0, pitch=0.0, roll=0.0):
    """Import one kit model, joined into one object. A textured material is
    renamed `tex:<kit>` so the driver can graft the atlas back; an untextured
    one keeps its flat baseColorFactor."""
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KIT_CACHE, kit_id, 'models', model + '.glb'))
    new = [o for o in bpy.context.scene.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    empties = [o for o in new if o.type != 'MESH']   # listed now: join() frees mesh objects
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    for e in empties:
        bpy.data.objects.remove(e, do_unlink=True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for m in o.data.materials:
        textured = m.node_tree and any(n.type == 'TEX_IMAGE' for n in m.node_tree.nodes)
        if textured:
            name = 'tex:' + kit_id
            if name in bpy.data.materials:
                idx = list(o.data.materials).index(m)
                o.data.materials[idx] = bpy.data.materials[name]
            else:
                m.name = name
    o.name = '%s_%s' % (kit_id, model)
    o.scale = (scale, scale, scale)
    o.rotation_mode = 'XYZ'   # the importer leaves QUATERNION, where place()'s euler turn is ignored
    place(o, at, yaw, pitch, roll)
    return o

# ---- moving parts ------------------------------------------------------------------
# A part that moves is ONE object named `anim_<verbs>` with its origin at its
# pivot: native/libttp-runtime/ttp/set_motion.h is the grammar, the renderer
# bakes and moves it (TtpRendererMotion.cpp). Build its pieces inside
# `with animated(name, pivot):`; finalize_and_export joins them after the
# chamfer, so the part costs one draw and keeps the piece's look. Names must be
# unique in a piece (Blender would suffix a repeat), so a repeated part carries
# a `#n` tag the grammar ignores. The motion's axes are the NODE's: a part built
# turned by `yaw` (a penguin facing its own way) passes it, and the node carries
# the turn, so a watch clamps about its beak and a waddle rocks over its feet.
# An `animated` block inside another is a part riding on that one (a key
# turning in a walking robot's back): its node is exported as the outer
# node's child, and the renderer moves it in the outer one's moving frame.

ANIMS = []
ANIM_STACK = []

def animate(objs, name, pivot, yaw=0.0):
    """Mark built objects as one moving part (what `animated` does for a block)."""
    gid = len(ANIMS)
    ANIMS.append((name, pivot, yaw, None))
    for o in objs:
        o['anim'] = gid

class animated:
    def __init__(self, name, pivot, yaw=0.0):
        self.name, self.pivot, self.yaw = name, pivot, yaw
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        self.gid = len(ANIMS)
        ANIMS.append((self.name, self.pivot, self.yaw, ANIM_STACK[-1] if ANIM_STACK else None))
        ANIM_STACK.append(self.gid)
        return self
    def __exit__(self, *exc):
        ANIM_STACK.pop()
        for o in bpy.context.scene.objects:
            if o not in self.before and o.get('anim') is None:   # an inner part keeps its own
                o['anim'] = self.gid
        return False

def split_off(o, pick):
    """Separate the faces of `o` whose local centre passes `pick` into their
    own object, and return it (a kit flag's cloth off its pole)."""
    import bmesh
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bm = bmesh.from_edit_mesh(o.data)
    for f in bm.faces:
        if pick(f.calc_center_median()):
            f.select_set(True)
    bm.select_flush(True)
    bmesh.update_edit_mesh(o.data)
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    return next(x for x in bpy.context.selected_objects if x is not o)

def kit_flag(model, at, yaw, scale, flap):
    """A kit flag whose cloth flaps: it dips and lifts about the cloth's own
    normal, hinged at the top of the pole. Seen across, which is how a car sees
    a flag turned to the road, that reads; a swing round the pole only narrows
    the cloth. The pole stays in the static bake."""
    o = kit('pirate', model, at, yaw=yaw, scale=scale)
    cloth = split_off(o, lambda c: c.x > 0.25)   # the kit's cloth flies along its +X off a 0.2 pole
    bpy.context.view_layer.update()
    top = max((cloth.matrix_world @ v.co).z for v in cloth.data.vertices)
    animate([cloth], flap, (at[0], top, at[2]))

def marker(name, at):
    """A mesh-less node: a path's waypoint (`path_<chain>_<k>`, a closed loop
    in k order) or where something happens (`anim_smoke`)."""
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.location = P(*at)
    return o

def join_anims(k):
    """Each `animated` group into one object, origin at its pivot (grown by k
    with the piece), rotation and scale applied so its frame is the piece's."""
    joined = {}
    for gid, (name, pivot, yaw, _) in enumerate(ANIMS):
        objs = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('anim') == gid]
        if not objs:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.convert(target='MESH')          # applies the chamfer
        if len(objs) > 1:
            bpy.ops.object.join()
        o = bpy.context.view_layer.objects.active
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bpy.context.scene.cursor.location = P(*pivot) * k
        bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
        if yaw:   # the turn moves from the vertices onto the node (yaw about up = Blender Z)
            o.data.transform(Matrix.Rotation(-yaw, 4, 'Z'))
            o.rotation_euler = (0.0, 0.0, yaw)
        o.name = name
        o.data.name = name
        joined[gid] = o
    bpy.context.view_layer.update()
    for gid, (_, _, _, parent) in enumerate(ANIMS):
        if parent is not None and gid in joined and parent in joined:
            child, over = joined[gid], joined[parent]
            child.parent = over
            child.matrix_parent_inverse = over.matrix_world.inverted()
    ANIMS.clear()

# ---- shared sub-assemblies ------------------------------------------------------

def flagpole(at, h, color, w=1.2, fh=0.7, pole=0xfff6eb, wave=None):
    """`wave` names the cloth's motion (a `#n` tag apart per flag), hinged at
    the top of the pole: a flap about z (the cloth's normal) dips and lifts it,
    which is what reads from a car seeing it across (kit_flag)."""
    x, y, z = at
    cyl(0.2, 0.3, (x, y, z), pole, segs=6)
    cyl(0.09, h, (x, y, z), pole, segs=6)
    sphere(0.17, (x, y + h + 0.1, z), pole, subdiv=1)
    # the cloth in two slabs, kinked as if the wind had it
    def cloth():
        box((w * 0.55, fh, 0.12), (x + w * 0.27 + 0.05, y + h - fh / 2 - 0.1, z), color)
        box((w * 0.5, fh * 0.9, 0.12), (x + w * 0.77, y + h - fh / 2 - 0.15, z + 0.08), color, yaw=-0.3)
    if wave:
        with animated(wave, (x, y + h, z)):
            cloth()
    else:
        cloth()

def post_and_rail(a, b, h, color, r=0.06):
    cyl(r, h, a, color, segs=6, smooth=False)
    cyl(r, h, b, color, segs=6, smooth=False)
    tube([(a[0], a[1] + h, a[2]), (b[0], b[1] + h, b[2])], r * 0.8, color, res=2, bevel_res=0)

def bench(at, yaw=0.0, color=0x9a7b55):
    """A park bench; whoever sits on it faces the piece's +Z turned by `yaw`."""
    box((1.6, 0.08, 0.5), (at[0], at[1] + 0.5, at[2]), color, yaw=yaw)
    box((1.6, 0.5, 0.08), (at[0] - 0.22 * math.sin(yaw), at[1] + 0.85, at[2] - 0.22 * math.cos(yaw)), color, yaw=yaw)
    for s in (-0.65, 0.65):
        box((0.08, 0.5, 0.5), (at[0] + s * math.cos(yaw), at[1] + 0.25, at[2] - s * math.sin(yaw)), 0x555b66, yaw=yaw)

def hut(w, h, d, at, wall, roof, yaw=0.0):
    """A little gabled hut, door on +X, dressed as a car is: a grey plinth, a
    dark door and windows standing proud in white frames, a chunky roof under
    a grey ridge."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def part(dx, dy, dz, size, color, pitch=0.0):   # offset in the hut's own frame
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw, pitch=pitch)
    part(0, h / 2, 0, (w, h, d), wall)
    part(0, 0.15, 0, (w + 0.2, 0.3, d + 0.2), 'grey')
    dw = min(d * 0.4, 0.9)
    part(w / 2 + 0.04, h * 0.36, 0, (0.1, h * 0.72 + 0.12, dw + 0.24), 'white')
    part(w / 2 + 0.1, h * 0.33, 0, (0.1, h * 0.66, dw), 'slate')
    for k in (-1, 1):
        part(0, h * 0.58, k * (d / 2 + 0.04), (w * 0.42 + 0.2, h * 0.3 + 0.2, 0.1), 'white')
        part(0, h * 0.58, k * (d / 2 + 0.1), (w * 0.42, h * 0.3, 0.1), 'slate')
        part(0, h + 0.3, k * (d + 0.5) / 4, (w + 0.5, 0.24, (d + 0.5) * 0.55), roof, pitch=-k * 0.6)
    part(0, h + 0.3 + 0.155 * (d + 0.5) + 0.08, 0, (w + 0.6, 0.22, 0.34), 'grey')

def crab(at, yaw=0.0, k=1.0):
    x, y, z = at
    sphere(0.35 * k, (x, y + 0.25 * k, z), 0xe4784f, subdiv=1, scale=(1.3, 0.6, 1), yaw=yaw)
    for s in (-1, 1):
        sphere(0.14 * k, (x + s * 0.5 * k * math.cos(yaw), y + 0.32 * k, z - s * 0.5 * k * math.sin(yaw)), 0xe4784f, subdiv=1)
        for j in range(3):
            a = yaw + s * (0.5 + j * 0.5)
            cyl(0.04 * k, 0.5 * k, (x, y + 0.2 * k, z), 0xd95f6a, segs=4, axis='across', yaw=a, smooth=False)
    for s in (-1, 1):
        sphere(0.06 * k, (x + 0.3 * k * math.cos(yaw), y + 0.4 * k, z - 0.3 * k * math.sin(yaw) + s * 0.12 * k), 0x2a2735, subdiv=1)

def starfish(at, color=0xe4784f, s=0.5):
    for k in range(5):
        cyl(0.11 * s, 0.55 * s, (at[0], at[1] + 0.05, at[2]), color, r2=0.02 * s, segs=5, axis='across', yaw=k * 2 * math.pi / 5, smooth=False)
    sphere(0.14 * s, (at[0], at[1] + 0.08, at[2]), color, subdiv=1)

def boulder(at, k=1.0, yaw=0.0, color='grey', squash=0.7):
    """A shore boulder, the Pirate Kit's grey rock: one faceted lump, wider
    than tall, its foot bedded in the sand."""
    return sphere(k, (at[0], at[1] + k * squash * 0.55, at[2]), color, subdiv=1,
                  scale=(1.25, squash, 1.0), yaw=yaw)

def beam(a, b, w, color, d=None):
    """A square bar from glTF point a to b, `w` across (`d` the other way)."""
    pa, pb = P(*a), P(*b)
    v = pb - pa
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    o = bpy.context.active_object
    o.scale = (max(w, MIN_T), max(d or w, MIN_T), v.length)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = v.to_track_quat('Z', 'Y')
    o.location = (pa + pb) / 2
    o['chamfer'] = 1
    return paint(o, color)

def rod(a, b, r, color, r2=None, segs=7):
    """A round log from glTF point a to b, tapering to r2."""
    pa, pb = P(*a), P(*b)
    v = pb - pa
    bpy.ops.mesh.primitive_cone_add(vertices=segs, radius1=r, radius2=r if r2 is None else r2,
                                    depth=v.length, end_fill_type='NGON')
    o = bpy.context.active_object
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = v.to_track_quat('Z', 'Y')
    o.location = (pa + pb) / 2
    return paint(o, color)

def snow_heap(at, k=1.0, yaw=0.0):
    """A drift of snow: two soft slabs, the kit's snow pile at a tenth of it."""
    x, y, z = at
    snowy(box((1.4 * k, 0.5 * k, 1.1 * k), (x, y + 0.25 * k, z), 0xf3f7fb, yaw=yaw))
    snowy(box((0.9 * k, 0.35 * k, 0.7 * k), (x + 0.1 * k, y + 0.6 * k, z), 0xf3f7fb, yaw=yaw + 0.5))

def pine(at, k=1.0):
    """A snowy pine: three faceted tiers and a white tip on a stub of trunk."""
    x, y, z = at
    box((0.3 * k, 0.5 * k, 0.3 * k), (x, y + 0.25 * k, z), 0x7a5a3a)
    for i, (r, h) in enumerate(((0.75, 0.7), (0.58, 0.6), (0.4, 0.5))):
        cyl(r * k, h * k, (x, y + (0.4 + i * 0.42) * k, z), 0x61cb8b, r2=0.08 * k, segs=6)
    cyl(0.18 * k, 0.3 * k, (x, y + 1.55 * k, z), 0xf3f7fb, r2=0.02, segs=6)

def rock(at, k=1.0, yaw=0.0, color=0x868ba1):
    """A grey rock: two blocks, one tipped on the other."""
    x, y, z = at
    box((1.2 * k, 0.8 * k, 1.0 * k), (x, y + 0.4 * k, z), color, yaw=yaw)
    box((0.7 * k, 0.5 * k, 0.6 * k), (x + 0.2 * k, y + 0.95 * k, z - 0.1 * k), 0x9aa1b4, yaw=yaw + 0.6)

def dead_tree(at, h=6.0, color=0x8a6a46, r=0.45):
    """A dead tree `h` tall, its trunk `r` at the foot, four bare limbs in
    proportion to it."""
    x, y, z = at
    k = h / 6.0
    cyl(r, h, (x, y, z), color, r2=r * 0.45, segs=7, smooth=False)
    for i, (a, t, l) in enumerate(((0.3, 0.55, 2.8), (2.4, 0.5, 2.4), (4.2, 0.65, 2.0), (1.4, 0.95, 1.6))):
        o = cyl(r * 0.36, l * k, (x, y + h * (0.55 + 0.12 * i), z), color, r2=r * 0.09, segs=5, smooth=False)
        tilted(o, math.cos(a) * t, math.sin(a) * t)

# ---- the pieces ----------------------------------------------------------------

PIECES = {}
GROW = {}
def piece(grow=1.0):
    def wrap(fn):
        name = fn.__name__.replace('_', '-')
        PIECES[name] = fn
        GROW[name] = grow
        return fn
    return wrap

# ====================================================================================
# BEACH
# ====================================================================================

@piece(1.45)
def rock_pool():
    # Tidepool: the big pool the tide left in the reef, deep blue in the
    # middle and pale at its shallow edge so it reads as water from the road.
    # Grey boulders heap up on the sea side (-X) and drop low on the road
    # side, so the water shows from the chase cam; anemones and starfish round
    # the rim, one stone breaking the surface. It is alive: two crabs scuttle
    # along its shore and a gull on the high rock watches the cars go by.
    disc(4.2, (0.2, 0.0, -0.3), 'sky', segs=20, h=0.05)            # the shallows
    disc(3.6, (-0.6, 0.0, 1.2), 'sky', segs=20, h=0.05)
    disc(3.2, (0.0, 0.03, -0.1), 'blue', segs=18, h=0.05)          # the deep middle
    disc(2.6, (-0.7, 0.03, 1.2), 'blue', segs=18, h=0.05)
    for a, d, k, sq in ((2.5, 5.2, 1.5, 0.8), (3.1, 5.5, 1.9, 0.85), (3.75, 5.2, 1.4, 0.75),
                        (4.4, 5.0, 1.0, 0.7), (1.9, 5.0, 0.9, 0.7), (5.3, 4.8, 0.6, 0.6)):
        boulder((math.cos(a) * d, 0, math.sin(a) * d), k, yaw=a * 1.7, squash=sq)
    boulder((math.cos(3.0) * 5.7, 1.3, math.sin(3.0) * 5.7 + 0.5), 0.9, yaw=0.8, color='slate')
    boulder((-0.9, 0, 0.8), 0.5, yaw=1.1)                          # breaking the surface
    for a, c in ((0.3, 0xe66a5a), (5.7, 0x8ecae6), (1.2, 0xa878e8)):  # anemones on the rim
        x, z = math.cos(a) * 4.4, math.sin(a) * 4.4
        cyl(0.3, 0.35, (x, 0, z), c, r2=0.42, segs=8)
    starfish((math.cos(0.8) * 4.6, 0.08, math.sin(0.8) * 4.6), 0xe4784f, s=1.2)
    starfish((math.cos(5.3) * 4.0, 0.08, math.sin(5.3) * 4.0), 0xf2c14e, s=1.1)
    live_crab(1, (5.4, 0.0, -2.8), (5.4, 0.0, 0.4), k=1.0, p=4.6)
    live_crab(2, (1.4, 0.0, 5.8), (3.9, 0.0, 5.0), k=0.85, p=5.4)
    gull((math.cos(3.0) * 5.7, 2.15, math.sin(3.0) * 5.7 + 0.5), 0.0, 1.0,
         'anim_watch:r=30+hop:r=12:h=0.4#gull')
    join_still('pool')

@piece(1.4)
def driftwood_trunk():
    # Driftwood: a whole tree the storm brought in, stripped of its bark, lying
    # along the verge where the strand line begins: a trunk long enough to race
    # beside, its root plate reared up at one end, two broken limbs, smaller
    # logs and a starfish in the sand, and a gull on the roots who watches the
    # cars and hops off as one goes by.
    L = 16.0
    wood = 0x8a6a46
    spine = [(0.0, 0.85, -L / 2 + 0.6), (0.2, 0.9, -L / 4), (0.0, 0.8, 0), (-0.3, 0.7, L / 4), (0.1, 0.55, L / 2)]
    tube(spine, 0.85, wood, res=4, bevel_res=2)
    # the root plate reared up across the trunk's end: a flat round of
    # tangled root twice the trunk's height, a few thick roots trailing out of
    # its rim and back along the sand
    cyl(1.9, 0.9, (0.0, 1.55, -L / 2 - 0.7), wood, segs=9, axis='along')
    for a, reach, droop in ((-110, 2.4, 0.6), (-50, 2.6, 0.3), (20, 2.5, 0.2), (85, 2.4, 0.5), (140, 2.1, 0.9)):
        r = math.radians(a)
        dx, dy = math.sin(r), math.cos(r)
        rod((dx * 1.5, 1.55 + dy * 1.5, -L / 2 - 0.3), (dx * reach, max(0.25, 1.55 + dy * reach - droop), -L / 2 + 0.6),
            0.34, wood, r2=0.14, segs=5)
    # two broken limbs
    rod((0.4, 1.3, L / 4), (1.3, 3.0, L / 4 + 1.0), 0.3, wood, r2=0.12, segs=6)
    rod((-0.5, 1.2, -1.0), (-2.3, 1.7, -0.3), 0.28, wood, r2=0.1, segs=6)
    # smaller logs washed up beside it
    rod((3.0, 0.32, 0.0), (4.6, 0.3, 4.6), 0.35, wood, r2=0.25)
    rod((-2.2, 0.25, 4.3), (-3.6, 0.22, 6.9), 0.25, wood, r2=0.18)
    gull((0.3, 3.35, -L / 2 - 0.7), 0.0, 0.8, 'anim_watch:r=30+hop:r=12:h=0.45#gull')
    starfish((-2.0, 0.05, -3.0), s=0.8)

@piece(1.5)
def lifeguard_tower():
    # Riptide: the surf patrol's white hut on stilts, up on the crest of the
    # dune bank behind the beach (its SET_GROUND, which the renderer lays as
    # terrain) so it looks out over the road to the swimmers. A boardwalk runs
    # down the dune's face toward the road (+X), marram grass in tufts on the
    # sand, signal flags flying either side, a rescue board against a stilt
    # and a ring buoy on the rail.
    g = set_ground('lifeguard-tower')
    W, D, H = 3.2, 3.0, 4.2
    y0 = g(0.0, 0.0) - 0.1
    for sx in (-1, 1):
        for sz in (-1, 1):
            lx, lz = sx * (W / 2 - 0.2), sz * (D / 2 - 0.2)
            gl = g(lx, lz) - 0.3
            cyl(0.14, y0 + H - gl, (lx, gl, lz), 0xfff6eb, segs=8)
    box((W + 0.4, 0.25, D + 0.4), (0, y0 + H + 0.12, 0), 0xfff6eb)
    box((W, 2.3, D), (-0.3, y0 + H + 0.25 + 1.15, 0), 0xfff6eb)
    box((0.1, 1.0, 1.4), (-0.3 + W / 2 + 0.02, y0 + H + 1.6, 0), 0x8ecae6)
    box((0.1, 1.0, 1.0), (-0.3 - W / 2 - 0.02, y0 + H + 1.6, 0), 0x8ecae6)
    box((1.4, 1.0, 0.1), (-0.3, y0 + H + 1.6, D / 2 + 0.02), 0x8ecae6)
    for s in (-1, 1):
        box((W + 0.9, 0.18, 0.5 * (D + 0.9) / math.cos(0.55)), (-0.3, y0 + H + 2.55 + 0.75, s * (D + 0.9) / 4),
            0xff5040, pitch=-s * 0.55)
    for sx in (-1, 1):
        box((0.08, 0.08, D + 0.4), (sx * (W / 2 + 0.16), y0 + H + 1.05, 0), 0xfff6eb)
    for sz in (-1, 1):
        box((W + 0.4, 0.08, 0.08), (0, y0 + H + 1.05, sz * (D / 2 + 0.16)), 0xfff6eb)
    for i in range(5):
        for sx in (-1, 1):
            cyl(0.04, 0.8, (sx * (W / 2 + 0.16), y0 + H + 0.25, -D / 2 + i * D / 4), 0xfff6eb, segs=6, smooth=False)
    # the ladder, from the dune's face up to the deck
    fx = W / 2 + 1.1
    foot = g(fx, 0.0) - 0.1
    for s in (-1, 1):
        beam((fx, foot, s * 0.35), (W / 2 + 0.2, y0 + H + 0.3, s * 0.35), 0.08, 0x9a7b55)
    for i in range(6):
        t = (i + 0.5) / 6
        box((0.08, 0.06, 0.78), (fx + (W / 2 + 0.2 - fx) * t, foot + (y0 + H + 0.3 - foot) * t, 0), 0x9a7b55)
    # the boardwalk down the dune's face to the beach, its planks on the sand
    x = fx + 0.5
    while g(x, 0.0) > 0.05:
        y, dy = g(x, 0.0), g(x + 0.2, 0.0) - g(x - 0.2, 0.0)
        box((0.34, 0.08, 1.3), (x, y + 0.04, 0), 0xb06041 if int(x * 3) % 3 else 0x9a6a46, roll=math.atan2(dy, 0.4))
        x += 0.42
    flagpole((-W / 2 - 0.2, y0 + H + 2.3, -D / 2 - 0.1), 3.2, 0xff5040, w=1.6, fh=0.9,
             wave='anim_sway:a=z:d=24:p=1.8#1')
    # a rescue board against a stilt, a ring buoy on the rail
    box((0.12, 2.4, 0.6), (W / 2 + 0.3, g(W / 2 + 0.3, -D / 2 - 0.5) + 1.1, -D / 2 - 0.5), 0xff5040, roll=0.18)
    torus(0.42, 0.1, (W / 2 + 0.2, y0 + H + 1.0, 0), 0xff5040, axis='across')
    # two signal flags on tall poles either side, flying
    for k, (z, c) in enumerate(((4.2, 0xff5040), (-4.2, 0x339cf2))):
        flagpole((1.6, g(1.6, z) - 0.2, z), 4.2, c, wave='anim_sway:a=z:d=24:p=%.1f#%d' % (2.0 + 0.3 * k, k + 2))
    # marram grass in tufts over the bank
    for (tx, tz, kk) in ((-3.0, 3.0, 1.0), (-4.2, -2.4, 0.9), (3.4, 5.6, 1.0), (4.6, -5.2, 0.8), (-2.0, 7.0, 0.9),
                         (-1.6, -7.4, 1.0), (6.0, 2.6, 0.8), (0.8, 9.4, 0.9), (-5.0, 6.4, 0.8), (2.4, -9.0, 0.9)):
        ty = g(tx, tz) - 0.05
        cyl(0.3 * kk, 0.85 * kk, (tx, ty, tz), 0x61cb8b, r2=0.03, segs=5)
        cyl(0.22 * kk, 0.6 * kk, (tx + 0.35, g(tx + 0.35, tz + 0.2) - 0.05, tz + 0.2), 0x9fc48e, r2=0.03, segs=5)
    join_still('tower')

def palm(at, h=4.2, lean=0.3, yaw=0.0):
    """A palm in the kit's manner: a leaning trunk in three tapering lengths,
    a crown of fronds bent down at their middles, two coconuts."""
    x, y, z = at
    dx, dz = math.cos(yaw), math.sin(yaw)
    pts = [(x + dx * lean * h * t * t, y + h * t, z + dz * lean * h * t * t) for t in (0, 0.36, 0.7, 1.0)]
    for i in range(3):
        rod(pts[i], pts[i + 1], 0.3 - 0.06 * i, 0x9a7b55, r2=0.26 - 0.06 * i, segs=6)
    tx, ty, tz = pts[-1]
    for i in range(6):
        a = yaw + i * math.pi / 3 + 0.3
        ca, sa = math.cos(a), math.sin(a)
        mid = (tx + ca * 1.2, ty + 0.25, tz + sa * 1.2)
        beam((tx, ty + 0.1, tz), mid, 0.55, 0x61cb8b, d=0.1)
        beam(mid, (tx + ca * 2.3, ty - 0.7, tz + sa * 2.3), 0.45, 0x61cb8b, d=0.1)
    for s in (-1, 1):
        box((0.3, 0.3, 0.3), (tx + s * 0.25 * dz, ty - 0.2, tz - s * 0.25 * dx), 0x9a6a46)

@piece(1.5)
def pirate_camp():
    # Cove: the crew's camp ashore by the start: a thatched shelter on its
    # posts with the rum and a barrel under it, a hammock slung between two
    # palms, barrels and a crate stacked by the Jolly Roger.
    kit('pirate', 'structure-roof', (0, 0, 0), yaw=0.2, scale=0.9)
    kit('pirate', 'barrel', (-0.5, 0, -0.5), yaw=0.4, scale=0.5)
    kit('pirate', 'crate', (0.4, 0, 0.5), yaw=0.3, scale=0.6)
    kit('pirate', 'bottle-large', (0.4, 0.46, 0.5), yaw=0.0, scale=0.55)
    # the hammock between two palms
    palm((-0.6, 0, -3.4), h=4.0, lean=0.25, yaw=math.radians(200))
    palm((-0.2, 0, -7.0), h=4.4, lean=0.3, yaw=math.radians(150))
    sl = sag((-0.55, 1.7, -3.65), (-0.25, 1.8, -6.75), 0.75, n=5)
    for i in range(4):
        beam(sl[i], sl[i + 1], 0.75, 0xfde4c7, d=0.1)
    # stores by the flag
    kit('pirate', 'barrel', (0.6, 0, 3.0), yaw=0.9, scale=0.5)
    kit('pirate', 'barrel', (-0.2, 0, 3.5), yaw=0.2, scale=0.5)
    kit('pirate', 'barrel', (0.2, 0.62, 3.25), yaw=1.4, scale=0.5)
    kit('pirate', 'crate', (1.3, 0, 4.2), yaw=-0.3, scale=0.6)
    kit_flag('flag-pirate-high', (-1.3, 0, 2.6), math.radians(90), 0.9,   # cloth to the road, it flaps
             'anim_sway:a=x:d=24:p=2.1')

@piece(1.5)
def skull_rock():
    # Cove: Skull Rock, a grey crag weathered into a skull, staring at the
    # road (+X) out of two black sockets over a jaw of teeth, the crag's
    # shoulder humped behind it and boulders heaped round its foot.
    stone = 'grey'
    sphere(2.6, (-1.6, 1.6, -0.6), 'slate', subdiv=1, scale=(1.1, 0.8, 1.2), yaw=0.7)   # the crag
    sphere(2.2, (0, 2.3, 0), stone, subdiv=1, scale=(0.95, 1.0, 1.1), yaw=0.3)       # the cranium
    box((1.8, 1.3, 2.7), (1.0, 0.65, 0), stone)                                     # the jaw
    for s in (-1, 1):
        sphere(0.62, (1.85, 2.45, s * 0.85), 'dark', subdiv=1, scale=(0.75, 1.0, 0.85))   # sockets
    box((0.36, 0.5, 0.5), (2.08, 1.65, 0), 'dark', pitch=math.radians(45))         # the nose
    for i in range(4):
        box((0.34, 0.46, 0.38), (1.95, 1.28, -0.69 + i * 0.46), 'white')           # teeth
    boulder((-0.4, 0, 2.6), 1.2, yaw=0.5)
    boulder((1.0, 0, -2.5), 1.0, yaw=1.7)
    boulder((2.6, 0, 1.9), 0.6, yaw=2.3)

@piece(1.5)
def shipwreck_ribs():
    # Cove: an old wreck run up the beach and picked clean: the keel half
    # buried, the ribs curving up out of the sand in pairs, a run of hull
    # planks still on the low side, the stem post standing at the bow and the
    # mast broken across the sand.
    wood = 0x8a6a46
    box((0.45, 0.4, 8.0), (0, 0.1, 0), wood)                                   # keel
    beam((0, 0.2, 3.8), (0, 1.6, 4.4), 0.4, wood)                               # stem
    beam((0, 1.6, 4.4), (0, 3.1, 4.5), 0.34, wood)
    beam((0, 0.2, -3.8), (0, 2.3, -4.2), 0.4, wood)                             # stern post
    for k in range(6):
        z = -3.0 + k * 1.2
        w = 1.0 - abs(k - 2.5) * 0.1                                            # beamiest midships
        for s in (-1, 1):
            hh = 0.6 if (s > 0) == (k % 3 == 1) else 1.0                        # some snapped short
            tube([(s * 0.1, 0.2, z), (s * 1.3 * w, 0.45, z), (s * 1.8 * w, 1.35, z),
                  (s * 1.9 * w, 1.35 + 1.1 * hh, z)], 0.12, wood, res=3)
    # what is left of the planking, along the low side
    for y, x, z0, z1 in ((0.75, 1.5, -3.2, 2.8), (1.15, 1.72, -3.0, 1.6), (1.6, 1.85, -2.2, 0.4)):
        box((0.14, 0.36, z1 - z0), (-x, y, (z0 + z1) / 2), wood)
    box((0.14, 0.36, 2.6), (1.5, 0.75, -1.4), wood)
    beam((1.0, 0.25, 0.8), (4.6, 0.3, -2.4), 0.32, wood)                        # the mast
    beam((3.3, 0.3, -1.2), (3.9, 0.3, -0.2), 0.2, wood)                         # its yard
    starfish((-1.0, 0.05, 2.6), s=0.8)

def deck_chair(at, color, yaw=0.0):
    """A folding deck chair facing -X turned by `yaw`: a wooden frame and a
    canvas sling slung low between its rails."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def p(dx, dy, dz):
        return (x + dx * c + dz * s, y + dy, z - dx * s + dz * c)
    seat, low, back = (-0.6, 0.38, 0), (0.15, 0.24, 0), (0.75, 1.05, 0)
    beam(p(*seat), p(*low), 0.62, color, d=0.08)
    beam(p(*low), p(*back), 0.62, color, d=0.08)
    for sz in (-0.36, 0.36):
        beam(p(0.95, 0, sz), p(0.72, 1.15, sz), 0.1, 0x9a7b55)                 # back rail
        beam(p(-0.7, 0, sz), p(-0.55, 0.5, sz), 0.1, 0x9a7b55)                 # front leg
        beam(p(-0.6, 0.48, sz), p(0.6, 0.62, sz), 0.1, 0x9a7b55)               # arm

def umbrella(at, r, h, colors, gores=8):
    """A beach umbrella: a pole and a canopy of gores in alternating
    colours, peaked over the pole and falling to its rim."""
    x, y, z = at
    beam((x, y, z), (x, y + h + 0.3, z), 0.2, 0xfff6eb)
    top = (x, y + h + 0.25, z)
    for i in range(gores):
        a0, a1 = i / gores * 2 * math.pi, (i + 1) / gores * 2 * math.pi
        rim0 = (x + math.cos(a0) * r, y + h - 0.45, z + math.sin(a0) * r)
        rim1 = (x + math.cos(a1) * r, y + h - 0.45, z + math.sin(a1) * r)
        poly([top, rim0, rim1], [(0, 1, 2)], colors[i % len(colors)])

def beach_ball(at):
    x, y, z = at
    sphere(0.36, (x, y + 0.36, z), 0xff5040, subdiv=1)
    sphere(0.37, (x, y + 0.36, z), 0xfff6eb, subdiv=1, scale=(0.3, 1, 1))

@piece(1.5)
def buoy_line():
    # Riptide: the swimming line off the lifeguard's beach: a rope of red and
    # white floats lying on the water between two big marker buoys, each
    # flying a flag. The swell lifts it: the markers rock and bob, and the
    # line rides up and down in four lengths, each out of step.
    for k, (s, flag) in enumerate(((-1, 0xff5040), (1, 0xffc044))):
        zb = s * 15.6
        with animated('anim_sway:a=z:d=20:p=3.1+bob:h=0.35:p=3.1#m%d' % k, (0, -0.25, zb)):
            cyl(0.55, 0.85, (0, -0.25, zb), 0xff5040, r2=0.36, segs=8)
            cyl(0.37, 0.3, (0, 0.6, zb), 0xfff6eb, r2=0.3, segs=8)
            box((0.14, 1.3, 0.14), (0, 1.5, zb), 0x2a2735)
            box((0.06, 0.45, 0.7), (0, 1.9, zb - s * 0.42), flag)
    for g in range(4):
        z0 = -15.2 + g * 7.6
        with animated('anim_bob:h=0.22:p=2.6#f%d' % g, (0, 0.16, z0 + 3.8)):
            beam((0, 0.16, z0 + 0.1), (0, 0.16, z0 + 7.5), 0.1, 0xfff6eb)
            for k in range(7):
                zf = z0 + 0.6 + k * 1.05
                cyl(0.24, 0.5, (0, 0.16, zf - 0.25), 0xfff6eb if (g * 7 + k) % 2 else 0xff5040, segs=6, axis='along')

def gull(at, yaw=0.0, k=1.0, life=None):
    """A gull standing on its feet, facing +X turned by `yaw`: white body and
    head, a grey back and wing tips, a yellow bill. `life` names its motion
    (set_motion.h), pivoting between its feet: watching the cars, hopping off
    as one passes close."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def p(dx, dy, dz):
        return (x + dx * c + dz * s, y + dy, z - dx * s + dz * c)
    def build():
        for sd in (-1, 1):
            box((0.08, 0.3 * k, 0.08), p(0, 0.15 * k, sd * 0.12 * k), 0xff7e44, yaw=yaw)
        box((0.95 * k, 0.5 * k, 0.55 * k), p(-0.05 * k, 0.55 * k, 0), 0xf8f8fb, yaw=yaw)       # body
        box((0.8 * k, 0.16 * k, 0.6 * k), p(-0.2 * k, 0.82 * k, 0), 0x9aa1b4, yaw=yaw)        # folded wings
        box((0.3 * k, 0.12 * k, 0.4 * k), p(-0.65 * k, 0.72 * k, 0), 0x38383d, yaw=yaw)       # wing tips
        box((0.42 * k, 0.4 * k, 0.38 * k), p(0.42 * k, 0.98 * k, 0), 0xf8f8fb, yaw=yaw)      # head
        box((0.3 * k, 0.1 * k, 0.12 * k), p(0.75 * k, 0.94 * k, 0), 0xffc044, yaw=yaw)       # bill
        for sd in (-1, 1):
            box((0.08, 0.08, 0.08), p(0.52 * k, 1.06 * k, sd * 0.2 * k), 0x2a2735, yaw=yaw)
    if life:
        with animated(life, (x, y, z), yaw):
            build()
    else:
        build()

def live_crab(n, a, b, k=1.0, p=5.0):
    """A crab facing +X that scuttles sideways from `a` to `b` and back along
    the shore of whatever it stands on (a path `crab<n>`, facing kept: a crab
    walks sideways). A red shell, claws up in front, its legs a bar a side,
    eyes on stalks."""
    marker('path_crab%d_0' % n, a)
    marker('path_crab%d_1' % n, b)
    x, y, z = a
    with animated('anim_path:c=crab%d:p=%.1f:f=0#%d' % (n, p, n), a):
        box((0.8 * k, 0.32 * k, 1.05 * k), (x, y + 0.3 * k, z), 0xe4784f)                 # shell
        box((0.6 * k, 0.12, 1.7 * k), (x - 0.05 * k, y + 0.12 * k, z), 0xd95f6a)          # the legs, splayed
        for s in (-1, 1):
            box((0.4 * k, 0.3 * k, 0.3 * k), (x + 0.58 * k, y + 0.38 * k, z + s * 0.36 * k), 0xd95f6a, yaw=s * 0.35)
        box((0.1, 0.22 * k, 0.42 * k), (x + 0.32 * k, y + 0.55 * k, z), 0x2a2735)         # eyes on their stalks

@piece(1.45)
def reef_shelf():
    # Tidepool: a stretch of the reef the low tide leaves bare, from the
    # waterline (-X) up the beach toward the road (+X), laid end to end round
    # the lap (tracks.js places it as a spine, each turned to the shore): flat
    # shelves of rock stepping down to the sea with pools of blue water caught
    # between them, a sea stack at the water's edge, weed and mussels on the
    # wet stone, anemones and a starfish. Blocks, not balls: a flat-shaded
    # ball costs ten blocks' vertices. Its crabs live at the rock pool: one
    # here would be a draw of its own in every run.
    # The shelves are strata dipping to the sea: each tips up toward the road
    # (roll), so its landward lip and its sunlit face show, wet slate at the
    # water, grey above it, the dry pale stone highest. Level slabs of one
    # grey read from the road as patches of tarmac.
    for (x, z, w, d, h, yw, rl, c) in ((-7.0, -5.0, 4.4, 5.0, 0.5, 0.2, 0.06, 'slate'),
                                       (-7.4, 0.8, 4.0, 5.2, 0.6, -0.15, 0.06, 'slate'),
                                       (-6.6, 5.8, 4.4, 4.4, 0.45, 0.1, 0.06, 'slate'),
                                       (-1.9, -4.4, 4.6, 6.0, 0.9, -0.2, 0.13, 'grey'),
                                       (-1.6, 3.6, 5.0, 6.0, 0.8, 0.25, 0.12, 'grey'),
                                       (3.2, -1.0, 3.4, 5.0, 0.7, 0.1, 0.18, 'lavender'),
                                       (3.0, 6.2, 3.0, 3.4, 0.6, -0.3, 0.2, 'lavender')):
        box((w, h, d), (x, h / 2 + 0.05, z), c, yaw=yw, roll=rl)
    # the pools between the shelves: a pale rim, the deep blue middle
    for (x, z, r, rim) in ((-4.5, -1.4, 1.7, True), (0.9, -0.2, 1.4, True), (-3.9, 5.6, 1.2, False),
                           (2.4, -6.1, 1.1, False)):
        if rim:
            disc(r + 0.4, (x, 0.0, z), 'sky', segs=8, h=0.05)
        disc(r, (x, 0.02, z), 'blue', segs=8, h=0.05)
    # the sea stack in the surf and the rocks along the water's edge: what
    # makes the run read from the road
    box((2.6, 2.3, 2.4), (-9.6, 1.1, -2.0), 'slate', yaw=0.5, roll=0.08)
    box((1.8, 1.3, 1.7), (-9.4, 2.7, -1.8), 'grey', yaw=1.2, roll=-0.12)
    box((1.8, 1.1, 1.6), (-9.8, 0.5, 4.2), 'grey', yaw=0.2)
    box((1.5, 0.9, 1.4), (-9.0, 0.4, -7.0), 'slate', yaw=0.8)
    # weed over the wet stone, mussels in its cracks
    for (x, y, z, w, d, yw, rl) in ((-7.2, 0.56, -4.2, 2.6, 1.6, 0.2, 0.06), (-7.6, 0.66, 1.2, 2.2, 2.4, -0.15, 0.06),
                                    (-6.8, 0.51, 6.0, 2.4, 1.4, 0.1, 0.06), (-2.4, 0.92, -3.4, 1.8, 1.0, -0.2, 0.13)):
        box((w, 0.08, d), (x, y, z), 'green', yaw=yw, roll=rl)
    for (x, y, z) in ((-6.0, 0.72, 1.6), (-2.6, 0.88, -5.6)):
        box((0.7, 0.18, 0.4), (x, y, z), 'dark', yaw=x)
    for (x, z, c) in ((-4.0, -2.4, 0xe66a5a), (1.4, 0.9, 0xa878e8), (-3.4, 5.0, 0xe66a5a)):
        cyl(0.22, 0.24, (x, 0.05, z), c, r2=0.32, segs=6)
    starfish((-1.0, 0.9, 4.4), 0xe4784f, s=1.0)
    join_still('reef')

@piece(1.4)
def strand_line():
    # Driftwood: a stretch of the line the storm tide left along the beach,
    # laid end to end from the great trunk to the bonfire (tracks.js places it
    # as a spine, turned a little each time so it wanders): bleached logs and
    # snapped branches, a dark tangle of weed, a lost fishing float on its
    # rope, a broken plank, a bottle and shells. It runs along Z.
    wood, pale = 0x8a6a46, 0xb8a686
    def x_at(z):                       # the line wanders as it goes
        return 0.7 * math.sin(z * 0.42)
    rod((x_at(-6.8) + 0.3, 0.34, -6.8), (x_at(-2.6) - 0.2, 0.28, -2.6), 0.36, wood, r2=0.26)
    rod((x_at(1.4) - 0.4, 0.42, 1.4), (x_at(6.6) + 0.5, 0.33, 6.6), 0.45, pale, r2=0.3)
    rod((x_at(3.6) + 0.1, 0.6, 3.6), (x_at(3.6) + 1.4, 2.2, 4.5), 0.22, pale, r2=0.1, segs=5)    # a branch thrust up
    rod((x_at(-1.0) + 0.9, 0.2, -1.6), (x_at(-1.0) - 1.2, 0.2, 0.2), 0.2, wood, r2=0.14, segs=5)
    # the weed: dark ribbons and wrack along the whole line
    for z in (-5.2, -3.6, -0.6, 0.9, 2.6, 5.0):
        box((1.3, 0.1, 0.55), (x_at(z) - 0.3, 0.05, z), 0x2f8f5b, yaw=0.6 * math.sin(z * 1.3))
    for z in (-4.4, 1.9, 6.2):
        box((0.9, 0.1, 0.45), (x_at(z) + 0.4, 0.05, z), 0x7a5a3a, yaw=0.8 * math.cos(z))
    # a fishing float still on a coil of its rope
    sphere(0.42, (x_at(-0.2) + 0.9, 0.38, -0.2), 0xff7e44, subdiv=1)
    torus(0.45, 0.1, (x_at(-0.2) + 1.0, 0.08, 0.9), 0xf2bf99, segs=8)
    # a broken plank, a bottle, shells, a starfish
    box((0.36, 0.1, 1.9), (x_at(4.2) - 1.0, 0.06, 4.2), 0x9a6a46, yaw=0.5)
    cyl(0.14, 0.55, (x_at(-3.0) + 0.6, 0.12, -3.0), 0x61cb8b, r2=0.1, segs=6, axis='across', yaw=0.7)
    for (dx, z) in ((0.5, -6.0), (-0.6, -2.0), (0.7, 2.2), (-0.4, 5.6)):
        box((0.22, 0.12, 0.2), (x_at(z) + dx, 0.06, z), 0xf5ead8, yaw=z)
    starfish((x_at(3.0) + 0.9, 0.05, 3.0), 0xe4784f, s=0.7)
    join_still('strand')

# ---- beach companions ----

def crab_pot(at, net, yaw=0.0):
    """A creel: a plank base and a net drawn over three wooden hoops."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def p(dz, dy=0.0):   # a point along the pot's own length
        return (x + dz * s, y + dy, z + dz * c)
    box((1.0, 0.12, 1.5), (x, y + 0.06, z), 0x9a7b55, yaw=yaw)
    cyl(0.46, 1.36, p(-0.68, 0.12), net, segs=8, axis='along', yaw=yaw)
    for dz in (-0.55, 0.0, 0.55):
        cyl(0.53, 0.14, p(dz - 0.07, 0.12), 0x9a7b55, segs=8, axis='along', yaw=yaw)

@piece(1.45)
def crab_pots():
    # Tidepool: the fishing gear hauled up the sand: two creels, a coil of
    # rope, a marker buoy on its stick.
    crab_pot((-0.9, 0, -0.6), 'sky', yaw=0.1)
    crab_pot((0.9, 0, 0.3), 'sky', yaw=1.45)
    torus(0.45, 0.1, (-0.6, 0.1, 1.5), 0xf2bf99, segs=10)
    sphere(0.5, (1.5, 0.45, 2.1), 0xff7e44, subdiv=1)
    box((0.12, 1.4, 0.12), (1.5, 1.4, 2.1), 0x2a2735)
    box((0.06, 0.4, 0.6), (1.5, 1.9, 2.4), 0xff5040)

@piece(1.5)
def treasure_dig():
    # Cove: X marks the spot. The chest dug half out of its hole, gold spilt
    # beside it, the spade stuck in the spoil heap, the red X painted on the
    # sand in front.
    cyl(1.25, 1.0, (-1.2, 0, 0.2), 'tan', r2=0.25, segs=7)                     # the spoil heap
    disc(1.2, (0.7, 0.0, 0.0), 0x9a6a46, segs=10, h=0.05)
    disc(0.8, (0.7, 0.02, 0.0), 'dark', segs=10, h=0.04)
    kit('pirate', 'chest', (0.7, -0.12, 0.0), yaw=math.radians(100), scale=0.75, roll=0.15)
    sphere(0.45, (1.55, 0.0, 0.9), 'yellow', subdiv=1, scale=(1.2, 0.55, 1.0))       # gold
    for gx, gz in ((2.0, 0.3), (1.8, 1.6), (2.3, 1.1)):
        box((0.22, 0.07, 0.22), (gx, 0.04, gz), 'yellow', yaw=gx)
    kit('pirate', 'tool-shovel', (-1.2, 0.55, 0.3), yaw=0.4, scale=0.5, roll=0.3)
    for a in (0.785, -0.785):
        box((0.26, 0.05, 1.5), (2.7, 0.03, -1.0), 0xff5040, yaw=a)

@piece(1.5)
def jetty():
    # Cove: the pirates' landing stage, from the sand (+X) out over the
    # shallows (-X) toward the ship: plank decking on square piles, a rowing
    # boat tied alongside the far end, barrels and crates waiting on the
    # sand at the near end.
    for k in range(22):                                                        # the decking
        box((0.44, 0.14, 2.0), (1.3 - k * 0.5, 0.5, 0), 0xb06041 if k % 3 else 0x9a6a46)
    for zs in (-0.8, 0.8):                                                      # the stringers
        box((11.0, 0.2, 0.24), (-4.15, 0.33, zs), 0x8a6a46)
    for k in range(5):
        for zs in (-0.95, 0.95):
            box((0.26, 1.7, 0.26), (1.3 - k * 2.7, -0.15, zs), 0x8a6a46)
    kit('pirate', 'boat-row-small', (-7.0, -0.05, 2.55), yaw=math.radians(90), scale=1.0)
    beam((-6.8, 0.66, 0.95), (-6.2, 0.5, 1.95), 0.08, 0xfde4c7)
    kit('pirate', 'barrel', (2.4, 0, -0.9), yaw=0.4, scale=0.5)
    kit('pirate', 'barrel', (2.7, 0, 0.1), yaw=1.2, scale=0.5)
    kit('pirate', 'crate', (2.4, 0, 1.4), yaw=0.2, scale=0.6)
    kit('pirate', 'crate', (2.4, 0.46, 1.4), yaw=0.6, scale=0.5)

@piece(1.5)
def cannon_post():
    # Cove: a cannon dug in on the dunes, its muzzle out to sea (-X), shot
    # piled at its breech and the black flag planted beside it.
    kit('pirate', 'cannon', (0, 0, 0), yaw=math.radians(-90), scale=0.9)      # the kit's muzzle is its +Z
    r = 0.34 * 0.6
    for bx, by, bz in ((1.45, r, 0.75), (1.45, r, 1.15), (1.8, r, 0.95), (1.57, 2.5 * r, 0.95)):
        kit('pirate', 'cannon-ball', (bx, by, bz), scale=0.6)
    kit_flag('flag-pirate', (0.3, 0, -1.9), math.radians(-90), 1.1,       # cloth to the road, it flaps
             'anim_sway:a=x:d=24:p=1.9')

@piece(1.3)
def bonfire():
    # Driftwood: the beach fire at the end of the strand line, burning in its
    # ring of stones: driftwood stood up in a cone, the flames licking round
    # out of it and the yellow heart leaping, its smoke going up, two logs
    # drawn up as seats.
    for k in range(8):
        a = k / 8 * 2 * math.pi
        box((0.5, 0.35, 0.4), (math.cos(a) * 1.2, 0.17, math.sin(a) * 1.2), 0x868ba1, yaw=-a)
    disc(1.0, (0, 0.0, 0), 0x38383d, segs=10, h=0.05)
    with animated('anim_spin:w=2.6#flames', (0, 0.05, 0)):                   # tongues of flame, uneven, turning
        for (dx, dz, r, h) in ((0.12, 0.0, 0.5, 1.25), (-0.25, 0.22, 0.34, 0.95), (-0.1, -0.3, 0.3, 0.8)):
            cyl(r, h, (dx, 0.05, dz), 0xff7e44, r2=0.04, segs=5)
    with animated('anim_sway:a=x:d=20:p=0.8+bob:h=0.25:p=0.55#heart', (0.05, 0.05, 0.05)):
        cyl(0.3, 1.75, (0.05, 0.05, 0.05), 0xffc044, r2=0.03, segs=5)       # its yellow heart
    for k in range(6):
        a = k / 6 * 2 * math.pi + 0.3
        rod((math.cos(a) * 0.85, 0.05, math.sin(a) * 0.85), (math.cos(a) * 0.12, 1.45, math.sin(a) * 0.12),
            0.13, 0x8a6a46, segs=5)
    for z in (-2.6, 2.6):
        cyl(0.32, 2.6, (-1.3, 0.32, z), 0x8a6a46, segs=7, axis='across', smooth=False)
    marker('anim_smoke', (0.0, 1.9, 0.0))

@piece(1.5)
def parasol():
    # Riptide: the one stretch of beach the swimmers have taken over, below
    # the lifeguard's dune: a crowd of striped umbrellas in a loose arc, a
    # towel spread under each, two deck chairs turned to the sea (-X), a cool
    # box, a beach ball, a bucket and spade by a little sandcastle.
    for (x, z, r, h, c) in ((0.0, -5.0, 1.8, 2.7, 0xff5040), (0.9, -1.9, 1.7, 2.5, 0x339cf2),
                            (-0.4, 1.2, 1.9, 2.8, 0xffc044), (0.8, 4.3, 1.7, 2.6, 0xff5040),
                            (-2.2, -2.8, 1.6, 2.4, 0x22c46e)):
        umbrella((x, 0, z), r, h, (c, 0xfff6eb))
    for (x, z, c, yw) in ((1.0, -4.6, 0x22c46e, 0.2), (1.8, -1.4, 0xff7e44, -0.25), (0.6, 1.9, 0x339cf2, 0.1),
                          (1.7, 4.8, 0xffc044, -0.3)):
        box((1.8, 0.05, 1.0), (x, 0.03, z), c, yaw=yw)
    deck_chair((-1.2, 0, 3.0), 0xff5040, yaw=0.25)
    deck_chair((-1.4, 0, 5.0), 0x339cf2, yaw=-0.15)
    box((0.7, 0.5, 0.5), (2.4, 0.25, 0.4), 0x339cf2)                       # the cool box
    box((0.75, 0.1, 0.55), (2.4, 0.55, 0.4), 0xfff6eb)
    beach_ball((2.9, 0, -3.0))
    cyl(0.3, 0.45, (3.0, 0, 2.6), 0xffc044, r2=0.25, segs=8)               # bucket and spade
    box((0.12, 0.08, 0.8), (3.4, 0.05, 3.1), 0x9a7b55, yaw=0.4)
    for (dx, dz, s) in ((0, 0, 0.9), (0.55, 0.5, 0.55), (-0.5, 0.45, 0.55), (0.0, -0.6, 0.5)):  # the sandcastle
        box((s, s * 0.8, s), (3.7 + dx, s * 0.4, -0.6 + dz), 0xe6d29a)
    join_still('parasols')

@piece(1.5)
def surfboards():
    # Riptide: three surfboards stood up in a wooden rack, noses high, fins
    # out, a stripe down each.
    half = [(0.0, 0.0), (0.2, 0.05), (0.32, 0.4), (0.36, 1.1), (0.32, 1.8), (0.2, 2.3), (0.0, 2.6)]
    outline = [(z, y) for z, y in half] + [(-z, y) for z, y in reversed(half[1:-1])]
    for k, (c, st) in enumerate(((0xff5040, 0xfff6eb), (0x339cf2, 0xffc044), (0xffc044, 0xff5040))):
        zc = -1.0 + k * 1.0
        board = prism([(zc + z, y) for z, y in outline], 0.0, 0.14, c)
        board.rotation_euler.y = -0.12
        box((0.16, 2.0, 0.12), (-1.3 * math.sin(0.12), 1.3, zc), st, roll=-0.12)
        box((0.4, 0.3, 0.08), (-0.24, 0.35, zc), 0x2a2735, roll=-0.12)
    for z in (-1.7, 1.7):
        box((0.24, 1.6, 0.24), (-0.5, 0.8, z), 0x9a7b55)
    box((0.24, 0.24, 3.6), (-0.5, 1.4, 0), 0x9a7b55)

# ====================================================================================
# SNOW
# ====================================================================================

def snowy(o, k=0.3):
    """Lying snow: a third of the ramp, so a drift at the foot of a tall piece
    stays snow-white instead of greying to stone (shade())."""
    o['ramp'] = k
    return o

def mound(peak, cx, cz, rx0, rx1, rz, color=0xeef4f9, rings=6, segs=18, sink=0.4, shape=1.6, jitter=0.0):
    """A hill on an oval foot round its summit (cx, cz): `rx1` out toward +X
    (the road), `rx0` behind, `rz` along. A polar mesh, so the hill is whole
    on every side, and its rim sinks `sink` under the ground so no edge stands
    in the air or fights the snow. Returns its height h(x, z) for what stands
    on it (the jitter, a faceted roughness on the inner rings, is left out)."""
    def R(dx, dz):
        a = math.atan2(dz, dx)
        rx = rx1 if math.cos(a) > 0 else rx0
        return 1.0 / math.sqrt((math.cos(a) / rx) ** 2 + (math.sin(a) / rz) ** 2)
    def g(t):
        return math.cos(min(t, 1.0) * math.pi / 2) ** shape
    def h(x, z):
        dx, dz = x - cx, z - cz
        t = math.hypot(dx, dz) / R(dx, dz)
        return (peak + sink) * g(t) - sink
    verts = [P(cx, peak, cz)]
    for i in range(1, rings + 1):
        t = i / rings
        for j in range(segs):
            a = j / segs * 2 * math.pi + (0.5 / segs * 2 * math.pi if i % 2 else 0.0)
            dx, dz = math.cos(a), math.sin(a)
            r = R(dx, dz) * t
            y = (peak + sink) * g(t) - sink
            if i < rings:
                y += jitter * (1 - t) * math.sin(j * 2.7 + i * 1.3)
            verts.append(P(cx + dx * r, y, cz + dz * r))
    faces = [(0, 1 + j, 1 + (j + 1) % segs) for j in range(segs)]
    for i in range(rings - 1):
        a0, b0 = 1 + i * segs, 1 + (i + 1) * segs
        for j in range(segs):
            k = (j + 1) % segs
            faces.append((a0 + j, b0 + j, b0 + k, a0 + k))
    me = bpy.data.meshes.new('mound')
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    if me.polygons[0].normal.z < 0:
        for p in me.polygons:
            p.flip()
    o = bpy.data.objects.new('mound', me)
    bpy.context.scene.collection.objects.link(o)
    snowy(paint(o, color), 0.45)
    return h

# The ground a piece was modelled standing on, when it is TERRAIN rather than
# part of the model: public/shared/tracks.js SET_GROUND, handed over by
# scripts/gen-set-prototypes.mjs (TTP_SET_GROUND). The renderer lays the same
# numbers as the track's ground wherever the piece stands, so what is built on
# it here — towers, pines, rocks — stands on the terrain in the game. In world
# units there; this frame is the build's, which the export grows by GROW.
SET_GROUND = json.loads(os.environ.get('TTP_SET_GROUND', '{}'))

def set_ground(name):
    """height(x, z) of the piece's SET_GROUND in the build frame: its mounds
    and fans, as the renderer's terrain has them (TtpRenderer::landforms;
    tracks.js setGroundY is the JS copy set-check reads): the highest mound, the fans on it,
    and the plain (0) past them. A mound's summit is `h` tall reaching `r`
    toward +X, `r1` behind and `rz` along, its flank cos(t*pi/2)^shape; a fan
    is a ridge's capsule, `len` along its +Z, `r`/`h` at the -Z end and
    `r1`/`h1` at the +Z end, a flat crest `top`; `yaw` turns either."""
    forms = [f for f in SET_GROUND.get('set-' + name, []) if f['kind'] in ('mound', 'fan')]
    if not forms:
        raise SystemExit('set-%s has no SET_GROUND mound: run it through scripts/gen-set-prototypes.mjs' % name)
    k = GROW[name]
    def h(x, z):
        best, fans = 0.0, 0.0                     # a fan lies ON the mounds: its rise adds
        for f in forms:
            a = math.radians(f.get('yaw', 0.0))
            c, s = math.cos(a), math.sin(a)
            lx = x * k * c - z * k * s - f.get('x', 0.0)
            lz = x * k * s + z * k * c - f.get('z', 0.0)
            if f['kind'] == 'mound':
                t = math.hypot(lx / (f['r'] if lx > 0 else f['r1']), lz / f['rz'])
                if t < 1.0:
                    best = max(best, f['h'] * math.cos(t * math.pi / 2) ** f.get('shape', 1.0))
                continue
            half = f.get('len', 0.0) / 2
            cz = min(half, max(-half, lz))
            at = (cz + half) / f['len'] if f.get('len') else 0.0
            r0, r1 = f['r'], f.get('r1', f['r'])
            t = math.hypot(lx, lz - cz) / (r0 + (r1 - r0) * at)
            if t >= 1.0:
                continue
            top = f.get('top', 0.0)
            q = 0.0 if t <= top else min(1.0, (t - top) / (1 - top))
            h0, h1 = f['h'], f.get('h1', f['h'])
            fans += (h0 + (h1 - h0) * at) * (1 - q * q * (3 - 2 * q))
        return (best + fans) / k
    return h

def group(objs, name):
    """Export `objs` as ONE node called `name` (joined after they are shaded
    and chamfered, so each part keeps its own swatch): a part the renderer moves
    as a whole, like the lift's chairs (`anim_` nodes)."""
    for o in objs:
        o['group'] = name
    return objs

def join_still(name):
    """Every part of the piece that stands still as ONE node `name`. The
    per-placement bake cuts a piece by whole part into 8 u tiles, a draw
    each, so a piece spread wide over the sand (a reef run, a dune with its
    boardwalk) would cost a dozen draws a placement; as one part it costs
    one wherever it stands. Call it last, after the moving parts are built."""
    return group([o for o in bpy.context.scene.objects
                  if o.type == 'MESH' and o.get('anim') is None], name)

def turned(cx, cz, yaw, lx, lz):
    """A point (lx, lz) in a frame at (cx, cz) turned by `yaw` (box()'s sense:
    its +Z runs along (sin yaw, cos yaw))."""
    c, s = math.cos(yaw), math.sin(yaw)
    return cx + lx * c + lz * s, cz - lx * s + lz * c

def pylon(at, h, yaw, ground=0.0):
    """A lift tower standing on `ground`, its crossarm at `h` across the line
    (the line runs along the tower's turned +Z)."""
    x, _, z = at
    cyl(0.3, h - ground + 0.4, (x, ground - 0.4, z), 0x555b66, segs=4)
    box((3.4, 0.34, 0.34), (x, h - 0.2, z), 0x555b66, yaw=yaw)
    for s in (-1, 1):
        gx, gz = turned(x, z, yaw, s * 1.4, 0)
        box((0.5, 0.3, 0.7), (gx, h + 0.05, gz), 0x2a2735, yaw=yaw)
    # the footing reaches well under the slope: the terrain is a 9 u grid's
    # chords across the curve this stands on, a little under it on a crest
    box((1.4, 1.2, 1.4), (x, ground - 0.3, z), 0x868ba1, yaw=yaw)

def chair(at, yaw, color=0x3f7bd9):
    """A two-seat chair hanging under the cable at `at`, facing down the line.
    Returns its parts."""
    x, y, z = at
    parts = [box((0.2, 1.5, 0.2), (x, y - 0.75, z), 0x2a2735, yaw=yaw)]
    for (lx, ly, lz, size, c) in ((0, -1.55, 0.1, (1.5, 0.16, 0.7), color),
                                  (0, -1.15, -0.2, (1.5, 0.7, 0.16), color),
                                  (0, -0.95, 0.5, (1.5, 0.2, 0.2), 0x2a2735)):
        px, pz = turned(x, z, yaw, lx, lz)
        parts.append(box(size, (px, y + ly, pz), c, yaw=yaw))
    return parts

def bullwheel(x, y, z, yaw):
    """The big wheel the cable turns round in a station, on its frame."""
    cyl(1.5, 0.3, (x, y - 0.15, z), 0x555b66, segs=8)
    cyl(0.5, 0.5, (x, y - 0.25, z), 0x2a2735, segs=8)
    box((0.4, 1.2, 0.4), (x, y + 0.75, z), 0x555b66)
    box((3.6, 0.3, 0.5), (x, y + 1.3, z), 0x555b66, yaw=yaw)

def station(x, z, y, ground, yaw, roof=0xff5040):
    """A lift station: the bullwheel under a red roof on four legs."""
    bullwheel(x, y, z, yaw)
    for sx in (-1, 1):
        for sz in (-1, 1):
            px, pz = turned(x, z, yaw, sx * 1.6, sz * 1.1)
            box((0.3, y + 1.6 - ground + 0.3, 0.3), (px, (y + 1.6 + ground - 0.3) / 2, pz), 0x555b66, yaw=yaw)
    box((4.4, 0.3, 3.2), (x, y + 1.6, z), roof, yaw=yaw)

def snowcat(x, y, z):
    """A piste groomer facing +X, built like the cars: two broad tracks, a red
    body and cab with dark glass, the blade up front, the tiller behind,
    lamps on the roof. Its pivot is under the middle of its tracks."""
    RED, DARK, GLASS = 0xcf534f, 0x38383d, 0x2f3a4a
    for s in (-1, 1):
        box((3.2, 0.7, 0.62), (x, y + 0.35, z + s * 0.82), DARK)
        box((3.0, 0.14, 0.66), (x, y + 0.74, z + s * 0.82), 0x868ba1)
    box((2.3, 0.6, 1.5), (x - 0.1, y + 1.0, z), RED)
    box((1.4, 1.0, 1.4), (x + 0.15, y + 1.8, z), RED)
    box((0.1, 0.62, 1.16), (x + 0.86, y + 1.88, z), GLASS)
    for s in (-1, 1):
        box((0.9, 0.55, 0.1), (x + 0.2, y + 1.9, z + s * 0.71), GLASS)
    box((1.5, 0.12, 1.5), (x + 0.15, y + 2.36, z), 0xfff6eb)
    box((0.3, 0.2, 0.9), (x + 0.5, y + 2.52, z), 0xff7e44)
    box((0.3, 1.0, 2.5), (x + 1.95, y + 0.6, z), 0xfff6eb)                 # the blade
    for s in (-1, 1):
        box((0.6, 0.18, 0.18), (x + 1.55, y + 0.85, z + s * 0.6), DARK)
    box((0.7, 0.36, 2.2), (x - 1.95, y + 0.4, z), DARK)                    # the tiller

@piece(1.35)
def ski_lift():
    # Powder: a ski mountain standing along the road, its summit behind (-X)
    # and its long flank toward the road, so the lap drives past the whole of
    # it side-on. The mountain is the TRACK's terrain (SET_GROUND); this is
    # what stands on it. The chairlift climbs that flank on the diagonal from
    # a valley station by the road over four towers to the top station on the
    # summit, chairs riding up one side and down the other round the haul
    # rope's loop (anim_path); a slalom piste runs down the other diagonal to a
    # finish banner on the flat; pines on the flanks.
    H = set_ground('ski-lift')
    V, T = (12.0, -22.0), (-36.0, -3.0)             # valley and top wheels
    dx, dz = T[0] - V[0], T[1] - V[1]
    L = math.hypot(dx, dz)
    yaw = math.atan2(dx, dz)
    nx, nz = dz / L, -dx / L                          # across the line
    y0, y1 = 3.4, H(*T) + 3.4
    fr = (0.22, 0.44, 0.64, 0.82)
    line = [(0.0, y0)] + [(f, H(V[0] + dx * f, V[1] + dz * f) + 5.6) for f in fr] + [(1.0, y1)]
    def cy(f):
        for (fa, ya), (fb, yb) in zip(line[:-1], line[1:]):
            if fa <= f <= fb:
                return ya + (yb - ya) * (f - fa) / (fb - fa)
        return line[-1][1]
    for f in fr:
        x, z = V[0] + dx * f, V[1] + dz * f
        pylon((x, 0, z), cy(f) + 0.3, yaw, ground=H(x, z))
    for s in (-1.4, 1.4):
        tube([(V[0] + dx * f + nx * s, y, V[1] + dz * f + nz * s) for f, y in line], 0.07, 0x2a2735,
             res=2, bevel_res=0, wire=True)
    # the haul rope's loop: up one side, round the top wheel, down the other;
    # the renderer carries the chairs round it (anim_path), facing their way
    up = [(V[0] + dx * f + nx * 1.4, y, V[1] + dz * f + nz * 1.4) for f, y in line]
    down = [(V[0] + dx * f - nx * 1.4, y, V[1] + dz * f - nz * 1.4) for f, y in reversed(line)]
    for k, pt in enumerate(up + down):
        marker('path_lift_%d' % k, pt)
    for k in range(8):
        f = (k + 0.5) / 8
        at = (V[0] + dx * f + nx * 1.4, cy(f), V[1] + dz * f + nz * 1.4)   # rest spot, any will do
        with animated('anim_path:c=lift:p=48:o=%.3f:f=1#%d' % (k / 8, k), at):
            chair(at, math.pi / 2, (0x3f7bd9, 0xff5040)[k % 2])        # faces +X, the way it rides
    # valley station on the flat by the road, its hut beside it, skis racked
    station(V[0], V[1], y0, 0.0, yaw)
    hx, hz = turned(V[0], V[1], yaw, 0.0, -4.4)
    hut(3.6, 2.6, 3.2, (hx, 0, hz), 0x9a7b55, 0xeef4f9, yaw=yaw + math.pi / 2)
    for k in range(4):
        px, pz = turned(V[0], V[1], yaw, 2.8, -1.6 + k * 0.4)
        box((0.12, 1.9, 0.18), (px, 0.95, pz), [0xff5040, 0x339cf2, 0x22c46e, 0xa259e6][k], yaw=yaw, roll=0.15)
    # top station on the summit, its hut behind it
    station(T[0], T[1], y1, H(*T) - 0.4, yaw)
    tx, tz = turned(T[0], T[1], yaw, 0.0, 4.2)
    hut(3.4, 2.4, 3.0, (tx, H(tx, tz) - 0.3, tz), 0x9a7b55, 0xeef4f9, yaw=yaw)
    # the slalom down the other diagonal to the finish on the flat
    S0, F = (-6.0, 5.0), (12.0, 21.0)
    px_, pz_ = F[0] - S0[0], F[1] - S0[1]
    pl = math.hypot(px_, pz_)
    pyaw = math.atan2(px_, pz_)
    qx, qz = pz_ / pl, -px_ / pl
    for k in range(5):
        f = 0.1 + k * 0.19
        s2 = 1.4 if k % 2 else -1.4
        x, z = S0[0] + px_ * f + qx * s2, S0[1] + pz_ * f + qz * s2
        c = 0xff5040 if k % 2 == 0 else 0x339cf2
        g = H(x, z)
        for e in (-0.7, 0.7):
            ex, ez = turned(x, z, pyaw, e, 0)
            box((0.2, 3.1, 0.2), (ex, g + 0.35, ez), c, yaw=pyaw)   # posts sunk past the jitter
        box((1.4, 0.7, 0.14), (x, g + 1.4, z), c, yaw=pyaw)
    for e in (-2.8, 2.8):
        ex, ez = turned(F[0], F[1], pyaw, e, 0)
        box((0.3, 3.4, 0.3), (ex, 1.5, ez), 0x555b66, yaw=pyaw)
    box((6.0, 0.9, 0.16), (F[0], 3.0, F[1]), 0x339cf2, yaw=pyaw)
    box((2.8, 0.5, 0.2), (F[0], 3.0, F[1]), 0xfff6eb, yaw=pyaw)
    # the piste runs on up from the slalom to the top station (its blue wash
    # is the terrain's, SET_GROUND's `paint`); a snowcat grooms it, crawling
    # up one side and back down the other (anim_path, pitched to the slope)
    run = [(-32.0, 12.0), S0, F]
    def along(off, back):
        pts = []
        for (ax, az), (bx, bz) in zip(run[:-1], run[1:]):
            l = math.hypot(bx - ax, bz - az)
            nx_, nz_ = -(bz - az) / l, (bx - ax) / l
            for i in range(5):
                f = i / 5
                pts.append((ax + (bx - ax) * f + nx_ * off, az + (bz - az) * f + nz_ * off))
        pts.append((run[-1][0] + nx_ * off, run[-1][1] + nz_ * off))
        return list(reversed(pts)) if back else pts
    loop = along(-3.6, False) + along(3.6, True)
    for k, (x, z) in enumerate(loop):
        marker('path_groom_%d' % k, (x, H(x, z) + 0.15, z))
    x, z = loop[3]
    with animated('anim_path:c=groom:p=40:f=2#cat', (x, H(x, z) + 0.15, z)):
        snowcat(x, H(x, z) + 0.15, z)
    # pines on the flanks, clear of the lift line and the piste
    for x, z, k in ((-50.0, -30.0, 2.6), (-50.0, 30.0, 2.8), (2.0, -32.0, 2.4), (4.0, 40.0, 2.6),
                    (-12.0, 20.0, 2.5), (-30.0, 45.0, 2.4), (-25.0, -45.0, 2.4)):
        pine((x, H(x, z) - 1.0, z), k * 1.1)   # sunk past the jitter

def skater(x, y, z, coat, hat, k=1.0):
    """A skater gliding toward +X on one skate, the other leg lifted behind,
    arms straight out for balance, a hat and a scarf in a second colour: nine
    chunky blocks, the pivot at the skate. Joined into one moving part by its
    caller."""
    def b(size, dx, dy, dz, color, roll=0.0):
        box([s * k for s in size], (x + dx * k, y + dy * k, z + dz * k), color, roll=roll)
    TROUSERS, SKIN, BOOT = 0x38383d, 0xf2bf99, 0xfff6eb
    b((0.56, 0.32, 0.28), 0.05, 0.16, 0.15, BOOT)                      # the gliding skate
    b((0.26, 0.8, 0.26), 0.0, 0.7, 0.15, TROUSERS, roll=-0.12)          # the standing leg
    b((0.26, 0.74, 0.26), -0.42, 0.88, -0.15, TROUSERS, roll=0.9)       # the lifted leg, behind
    b((0.5, 0.28, 0.26), -0.8, 0.6, -0.15, BOOT, roll=0.9)
    b((0.6, 0.85, 0.7), 0.05, 1.55, 0.0, coat, roll=-0.25)             # the coat, leaning in
    b((0.22, 0.22, 2.3), 0.05, 1.72, 0.0, coat)                         # arms out
    b((0.66, 0.2, 0.74), 0.12, 1.98, 0.0, hat)                          # the scarf
    b((0.44, 0.44, 0.44), 0.2, 2.32, 0.0, SKIN)                         # the head
    b((0.5, 0.3, 0.5), 0.18, 2.64, 0.0, hat)                            # the hat

@piece(1.0)
def frozen_lake():
    # Flurry: a frozen lake at the bottom of the land, the snowbanks round it
    # and the plain it lies on are the track's terrain (SET_GROUND), and the
    # road crosses its east edge on its stilts (+X, toward the road). Built in
    # world units. Skaters glide round a rink on the west ice (anim_path); a
    # red ice-fishing shanty with its fisher jigging a rod by his hole; a
    # snowman on the ice by the bank.
    R = 15.0
    disc(R, (0, 0, 0), 0xa9d7ee, segs=40, h=0.06)
    disc(R - 3.0, (0, 0.01, 0), 0x8ecae6, segs=32, h=0.06)          # the clear ice in the middle
    # the rink: an oval round the west ice, the skaters spread round it
    N = 14
    for j in range(N):
        a = j / N * 2 * math.pi
        marker('path_rink_%d' % j, (-1.0 + math.cos(a) * 7.0, 0.07, 2.0 + math.sin(a) * 8.0))
    for n, (coat, hat) in enumerate(((0xcf534f, 0x3f7bd9), (0x3f7bd9, 0xffc044), (0x61cb8b, 0xcf534f))):
        a = n / 3 * 2 * math.pi
        at = (-1.0 + math.cos(a) * 7.0, 0.07, 2.0 + math.sin(a) * 8.0)
        with animated('anim_path:c=rink:p=16:o=%.3f:f=1#%d' % (n / 3, n), at):
            skater(at[0], at[1], at[2], coat, hat, k=0.95)
    # the shanty: a red hut on skids by its fishing hole, a stovepipe
    sx, sz = -9.5, -9.5
    box((2.6, 0.12, 2.0), (sx, 0.12, sz), 0x6e4a32)
    box((2.4, 1.9, 1.8), (sx, 1.13, sz), 0xcf534f)
    box((2.8, 0.22, 2.2), (sx, 2.18, sz), 0xfff6eb, roll=0.12)
    box((0.1, 1.3, 0.8), (sx + 1.22, 0.9, sz), 0x38383d)
    box((0.3, 0.9, 0.3), (sx - 0.7, 2.6, sz - 0.4), 0x555b66)    # cold: the cabin's is the smoke
    box((1.1, 0.04, 1.1), (sx + 2.6, 0.08, sz + 1.0), 0x2f3a4a)        # the hole
    cyl(0.32, 0.55, (sx + 2.0, 0.07, sz + 2.1), 0x555b66, segs=8)       # his bucket
    box((0.5, 0.7, 0.55), (sx + 2.0, 0.98, sz + 2.1), 0x6e4a32)         # the fisher, sat on it
    box((0.42, 0.42, 0.42), (sx + 2.05, 1.55, sz + 2.1), 0xf2bf99)
    box((0.5, 0.2, 0.5), (sx + 2.05, 1.84, sz + 2.1), 0xffc044)
    with animated('anim_sway:a=x:d=22:p=1.6#rod', (sx + 2.2, 1.1, sz + 2.0)):
        box((0.12, 0.12, 1.9), (sx + 2.45, 1.45, sz + 1.2), 0x2a2735, pitch=0.45)
    # on the ice by the west bank, a snowman in a hat
    snowman((-11.0, 0.07, 6.0), 0.9, hat=True)

@piece(1.45)
def snow_fort():
    # Glacier: a big snow fort built the way the igloo is, of cut snow blocks
    # laid in courses (the chamfers and the shading tell them apart): a square
    # of walls with battlements, the gateway open to the road (+X), a round
    # lookout tower of blocks at the back corner flying a flag, snowballs
    # piled ready inside and out, a snowman keeping watch by the gate. The
    # blocks are rounded, packed snow rather than cut ice. No pines of its
    # own: its footprint is what levels the moraine it stands on.
    SNOW = 0xf3f7fb
    H = 5.0                                                        # half a side
    def cut(size, at, yaw=0.0):
        snowy(box(size, at, SNOW, yaw=yaw), 0.4)['round'] = 0.22
    def brick(x, y, z, across):
        cut((1.9, 1.0, 1.0) if across else (1.0, 1.0, 1.9), (x, y, z))
    for c in range(2):                                             # two courses, the joints staggered
        y = 0.5 + c
        for k in range(5):
            t = -H + 1.0 + k * 2.0 + (1.0 if c % 2 else 0.0)
            if t > H - 0.9:
                continue
            if abs(t) > 1.6:
                brick(H, y, t, False)                              # the front wall, the gate left open
            brick(-H, y, t, False)                                 # the back wall
            for sz in (-1, 1):
                brick(t, y, sz * H, True)                          # the side walls
    for sx in (-1, 1):                                             # the corners
        for sz in (-1, 1):
            for c in range(2):
                cut((1.0, 1.0, 1.0), (sx * H, 0.5 + c, sz * H))
    for k in range(5):                                             # battlements on every other block
        t = -H + 1.0 + k * 2.0
        if abs(t) > 1.6:
            cut((1.0, 0.8, 1.0), (H, 2.4, t))
        cut((1.0, 0.8, 1.0), (-H, 2.4, t))
        for sz in (-1, 1):
            cut((1.0, 0.8, 1.0), (t, 2.4, sz * H))
    tx, tz, R = -H, -H, 1.8                                        # the lookout tower
    for c in range(5):
        n = 7
        for k in range(n):
            a = (k + 0.5 * (c % 2)) / n * 2 * math.pi
            cut((0.9, 1.0, 1.55), (tx + math.cos(a) * R, 0.5 + c, tz + math.sin(a) * R), yaw=-a)
    snowy(cyl(R + 0.5, 0.3, (tx, 5.0, tz), SNOW, segs=12), 0.4)
    flagpole((tx, 5.3, tz), 3.2, 0xff5040)
    def pile(x, z):                                                # snowballs: four and one on top
        for dx, dz in ((-0.45, -0.45), (0.45, -0.45), (-0.45, 0.45), (0.45, 0.45)):
            snowy(sphere(0.45, (x + dx, 0.42, z + dz), SNOW, subdiv=1), 0.4)
        snowy(sphere(0.45, (x, 0.95, z), SNOW, subdiv=1), 0.4)
    pile(H - 2.0, 2.6)
    pile(H + 2.2, -3.2)
    snowman((H + 2.6, 0, 3.0), 0.9, hat=True)

@piece(1.45)
def avalanche_slide():
    # Avalanche: a broad mountain behind the verge (summit at -X) whose face
    # let go: the broken crown near the top, the bare rock of the chute below
    # it, and the debris fan of tumbled snow blocks and rocks spread out at
    # its foot toward the road, a pine snapped and its trunk thrown down, a
    # buried sled. Forest stands either side of the chute. The mountain is
    # the track's terrain (SET_GROUND); this is what lies on it.
    H = set_ground('avalanche-slide')
    # the crown: the broken edge of the slab, a step of rock across the face
    for z in (-2.6, 0.0, 2.6):
        x = -28.0 + 0.4 * abs(z)
        box((0.9, 1.0, 2.8), (x, H(x, z) + 0.2, z), 0x868ba1, yaw=0.15 * z)
    # the chute: the scar the slab left, scoured to grey rock, lying on the
    # face and widening as it runs down into the fan, whose blocks cover its end
    xs = [-27.0 + 3.3 * i for i in range(8)]
    verts = []
    for i, x in enumerate(xs):
        w = 1.8 + 0.45 * i
        for z in (-w, 0.0, w):
            # lifted clear of the terrain's 9 u chords, which cut a little
            # above the curve where the face is hollow and the fan meets it
            verts.append((x, H(x, z + 0.3 * math.sin(i)) + (0.34 if z == 0.0 else 0.3), z + 0.3 * math.sin(i)))
    faces = [(3 * i + j, 3 * i + j + 1, 3 * (i + 1) + j + 1, 3 * (i + 1) + j) for i in range(len(xs) - 1) for j in (0, 1)]
    poly(verts, faces, 0x9aa1b4)
    for i, x in enumerate((-20.0, -12.0, -4.0)):
        rock((x, H(x, 0.4) - 0.2, 0.4 * (i % 2 * 2 - 1)), 0.8, yaw=i * 1.9)
    # the debris fan (SET_GROUND's `fan`, the snow that came down lying on the
    # mountain's foot over the chute's end): tumbled snow blocks over it, the
    # runout thinning out on toward the road (+X). The fan itself stops a grid
    # cell short of the road, where the deck's cap would hold the land under it
    # and leave what was built on it floating.
    for i, (x, z, k) in enumerate([(-6.0, 0.5, 1.5), (-3.0, -2.5, 1.4), (-1.0, 3.0, 1.3), (2.0, -1.0, 1.7),
                                   (3.5, 2.5, 1.4), (4.0, -3.5, 1.3), (5.5, 0.5, 1.2), (6.5, -2.0, 1.0),
                                   (7.0, 3.0, 0.9), (2.5, 4.5, 1.1), (1.5, -4.5, 1.2), (8.0, 0.0, 0.8),
                                   (4.8, 5.2, 0.8), (6.0, -6.0, 0.9), (7.5, 5.8, 0.8)]):
        k *= 1.3
        snowy(box((1.3 * k, 0.9 * k, 1.1 * k), (x, H(x, z) + 0.3 * k, z), 0xf3f7fb,
                  yaw=i * 1.1, roll=0.3 * math.sin(i * 2.3), pitch=0.25 * math.cos(i * 1.7)), 0.5)
    for i, (x, z, k) in enumerate([(3.0, 0.8, 1.2), (5.0, -1.2, 1.0), (1.0, 2.2, 1.1), (6.2, 2.0, 0.8),
                                   (-4.5, -1.0, 1.1)]):
        rock((x, H(x, z) - 0.15, z), k, yaw=i * 1.4)
    # the snapped pine: its stump on the slope, the trunk thrown down the fan
    cyl(0.32, 1.4, (-1.0, H(-1.0, -3.2) - 0.3, -3.2), 0x7a5a3a, r2=0.26, segs=6)
    cyl(0.28, 4.2, (5.6, H(5.6, -5.0) + 0.1, -5.0), 0x7a5a3a, r2=0.16, segs=6, axis='across', yaw=0.5)
    pine((6.5, H(6.5, -6.4) - 0.2, -6.4), 1.9)
    kit('holiday', 'sled', (5.0, H(5.0, 3.6) + 0.25, 3.6), yaw=0.8, scale=1.4, roll=0.6)
    # forest either side of the chute
    for x, z, k in ((-12.0, -12.0, 2.6), (-6.0, -16.0, 2.4), (-22.0, -14.0, 2.4), (-12.0, 12.0, 2.6),
                    (-5.0, 15.0, 2.4), (-22.0, 14.0, 2.2), (-34.0, -28.0, 2.6), (-32.0, 30.0, 2.6),
                    (-10.0, -36.0, 2.4), (-10.0, 36.0, 2.4)):
        pine((x, H(x, z) - 0.3, z), k)

@piece(1.5)
def igloo():
    # Glacier's support: an igloo of snow blocks, laid in rings that step in
    # as they rise and close over the top, each block cut square so its
    # chamfered edges and the shading tell the blocks apart; a tunnel of
    # blocks to the road (+X), its doorway dark, a snowman at the door and a
    # lantern.
    R = 2.8
    snowy(sphere(R * 0.9, (0, 0, 0), 0xf3f7fb, subdiv=1), 0.4)       # the packed snow behind the joints
    rows = 5
    span = math.pi / 2 * 0.9 / rows
    for row in range(rows):
        phi = (row + 0.5) * span
        rr = R * math.cos(phi)
        n = max(5, round(2 * math.pi * rr / 1.3))
        for k in range(n):
            a = (k + 0.5 * (row % 2)) / n * 2 * math.pi
            snowy(box((0.5, R * span * 0.94, 2 * math.pi * rr / n * 0.94),
                      (math.cos(a) * rr, R * math.sin(phi), math.sin(a) * rr), 0xf3f7fb,
                      yaw=-a, roll=-phi * 0.85), 0.4)
    snowy(box((1.3, 0.4, 1.3), (0, R * 0.98, 0), 0xf3f7fb, yaw=0.3), 0.4)   # the key block
    # the tunnel toward the road: two courses of blocks over a dark doorway
    for k in range(3):
        x = R - 0.2 + k * 0.85
        for sz in (-1, 1):
            snowy(box((0.8, 1.2, 0.5), (x, 0.6, sz * 0.75), 0xf3f7fb), 0.4)
        snowy(box((0.8, 0.45, 2.0), (x, 1.42, 0), 0xf3f7fb), 0.4)
    box((0.1, 1.1, 1.0), (R + 1.95, 0.55, 0), 0x2f3a4a)
    snowman((R + 3.2, 0, 1.9), 0.8)
    kit('holiday', 'lantern', (R + 2.8, 0, -1.9), yaw=0, scale=1.5)
    snow_heap((-3.2, 0, 2.4), 1.4, yaw=1.0)

@piece(1.5)
def windsock():
    # Avalanche's support: a windsock streaming on a tall mast, a slatted
    # white weather screen on legs and a rescue sled by its foot. The sock
    # swings round the mast as the wind veers off the mountain.
    cyl(0.1, 7.0, (0, 0, 0), 0x555b66, r2=0.06, segs=6, smooth=False)
    with animated('anim_sway:a=y:d=40:p=5.5#sock', (0, 6.9, 0)):
        torus(0.35, 0.04, (0, 6.9, 0), 0x2a2735, axis='across')
        for k in range(5):
            c = 0xff5040 if k % 2 == 0 else 0xfff6eb
            cyl(0.36 - k * 0.04, 0.6, (0.3 + k * 0.6, 6.85 - k * 0.08, 0), c, r2=0.32 - k * 0.04, segs=10, axis='across', smooth=False)
    # the weather screen: a louvred box on four legs under a little roof
    for sx in (-0.35, 0.35):
        for sz in (-0.35, 0.35):
            box((0.12, 1.1, 0.12), (1.6 + sx, 0.55, 1.6 + sz), 0x555b66)
    box((1.0, 0.8, 1.0), (1.6, 1.5, 1.6), 0xfff6eb)
    for y in (1.3, 1.55, 1.8):
        box((0.06, 0.08, 0.8), (2.12, y, 1.6), 0x868ba1)
    box((1.3, 0.14, 1.3), (1.6, 2.0, 1.6), 0x555b66)
    kit('holiday', 'sled', (-1.6, 0, -1.2), yaw=0.4, scale=1.4)
    snow_heap((0.5, 0, -2.6), 1.1, yaw=0.2)

@piece(1.5)
def log_pile():
    # Flurry's support: firewood stacked with its cut ends to the road under
    # a lean-to, an axe in the chopping block beside it.
    for row in range(3):
        for k in range(4 - row):
            z = -0.9 + k * 0.6 + row * 0.3
            y = 0.3 + row * 0.52
            cyl(0.3, 2.2, (-1.1, y, z), 0x8a6a46, segs=6, axis='across')
            cyl(0.22, 0.06, (1.1, y, z), 0xd9b48a, segs=6, axis='across')
    # the lean-to: tall at the front, a snowed board roof down to the back
    for s in (-1, 1):
        box((0.2, 2.4, 0.2), (1.4, 1.2, s * 1.5), 0x8a6a46)
        box((0.2, 1.8, 0.2), (-1.4, 0.9, s * 1.5), 0x8a6a46)
    box((3.4, 0.16, 3.5), (0, 2.18, 0), 0x8a6a46, roll=-0.2)
    snowy(box((3.3, 0.12, 3.4), (-0.03, 2.32, 0), 0xeef4f9, roll=-0.2))
    cyl(0.5, 0.6, (2.4, 0, 1.6), 0x8a6a46, segs=8)
    box((0.12, 0.9, 0.12), (2.4, 0.7, 1.6), 0x9a7b55, pitch=0.4)
    box((0.3, 0.3, 0.08), (2.4, 1.06, 1.82), 0x555b66)

# ---- snow companions: small pieces that carry a track's story round its lap ----

@piece(1.4)
def ski_rack():
    # Powder: pairs of skis and poles racked by the piste, a trail sign, a
    # heap of snow.
    for z in (-1.3, 1.3):
        box((0.2, 1.6, 0.2), (0, 0.8, z), 0x9a7b55)
    box((0.2, 0.2, 3.0), (0, 1.45, 0), 0x9a7b55)
    for k, c in enumerate((0xff5040, 0x339cf2, 0x22c46e)):
        for e in (-0.11, 0.11):
            z = -0.9 + k * 0.7 + e
            box((0.1, 1.8, 0.18), (0.25, 0.9, z), c, roll=-0.18)
            box((0.1, 0.3, 0.18), (0.16, 1.92, z), c, roll=0.5)
    for k in range(2):
        for e in (-0.1, 0.1):
            z = 1.0 + e
            box((0.14, 1.4, 0.14), (0.3 + k * 0.25, 0.7, z - 0.25 + k * 0.5), 0x2a2735, roll=-0.25)
            box((0.32, 0.06, 0.32), (0.41 + k * 0.25, 0.25, z - 0.25 + k * 0.5), 0x2a2735)
    box((0.2, 2.4, 0.2), (0.6, 1.2, 2.4), 0x555b66)
    box((0.12, 0.9, 1.3), (0.7, 2.1, 2.4), 0x339cf2)
    box((0.14, 0.3, 0.8), (0.76, 2.1, 2.4), 0xfff6eb)
    snow_heap((-0.8, 0, -1.8), 1.3, yaw=0.6)

@piece(1.4)
def piste_fence():
    # Powder: an orange safety net strung along a bend, marker poles at the ends.
    L = 8.0
    for k in range(5):
        box((0.2, 1.4, 0.2), (0, 0.7, -L / 2 + k * L / 4), 0x2a2735)
    box((0.08, 0.9, L), (0.1, 0.75, 0), 0xff7e44)
    for z in (-L / 2 - 0.6, L / 2 + 0.6):
        for k in range(4):
            box((0.22, 0.5, 0.22), (0, 0.25 + k * 0.5, z), 0xff5040 if k % 2 == 0 else 0xfff6eb)

@piece(1.4)
def log_cabin():
    # Flurry: a log cabin, each wall its own logs whose ends cross out past
    # the corners (the side walls' laid half a log higher), a snowed gable
    # roof, a stone chimney, a lit window by the door and one in each side.
    W, D, H = 4.2, 3.4, 2.4                       # across (door on +X), along, wall height
    box((W + 0.3, 0.25, D + 0.3), (0, 0.12, 0), 0x868ba1)
    box((W - 0.2, H, D - 0.2), (0, H / 2 + 0.1, 0), 0x6e4a32)          # the chinking between the logs
    p = (H - 0.15) / 5
    for k in range(5):
        for s in (-1, 1):
            box((0.4, 0.4, D + 0.5), (s * (W / 2 - 0.2), 0.25 + (k + 0.5) * p, 0), 0x8a5a3a)
            if k < 4:
                box((W + 0.5, 0.4, 0.4), (0, 0.25 + (k + 1) * p, s * (D / 2 - 0.2)), 0x9a5f3c)
    # gables on the door end and the back
    for s in (-1, 1):
        prism([(D / 2 - 0.05, H + 0.1), (-D / 2 + 0.05, H + 0.1), (0, H + 0.1 + (D / 2) * math.tan(0.6))],
              s * (W / 2 - 0.1), 0.2, 0x8a5a3a)
    # the roof: two snowed slabs meeting over the ridge (along X), eaves past the walls
    ridge = H + 0.1 + (D / 2) * math.tan(0.6)
    run = D / 2 + 0.45
    for s in (-1, 1):
        zc = s * run / 2
        snowy(box((W + 0.8, 0.26, run / math.cos(0.6) + 0.1), (0, ridge - (run / 2) * math.tan(0.6) + 0.16, zc),
                  0xeef4f9, pitch=-s * 0.6), 0.5)
    box((W + 0.9, 0.22, 0.36), (0, ridge + 0.3, 0), 0x868ba1)
    # chimney through the back slope
    box((0.7, 1.9, 0.7), (-1.1, ridge - 0.2, -0.75), 0x868ba1)
    snowy(box((0.82, 0.14, 0.82), (-1.1, ridge + 0.8, -0.75), 0xeef4f9))
    marker('anim_smoke', (-1.1, ridge + 0.9, -0.75))   # the first cabin on a track smokes
    # the door and two lit windows on the front, one on each side
    box((0.1, 1.75, 1.1), (W / 2 + 0.06, 1.0, -0.55), 0xfff6eb)
    box((0.1, 1.55, 0.85), (W / 2 + 0.12, 0.92, -0.55), 0x38383d)
    box((0.1, 0.8, 0.8), (W / 2 + 0.06, 1.45, 0.95), 0xfff6eb)
    box((0.1, 0.6, 0.6), (W / 2 + 0.12, 1.45, 0.95), 0xffc044)
    for s in (-1, 1):
        box((1.0, 0.8, 0.1), (0.7, 1.45, s * (D / 2 + 0.06)), 0xfff6eb)
        box((0.8, 0.6, 0.1), (0.7, 1.45, s * (D / 2 + 0.12)), 0xffc044)

def snowman(at, k=1.0, hat=False):
    """Three blocks of snow, coal eyes and buttons, a carrot facing +X, stick
    arms, a scarf: built the way the cars are, in chunky blocks."""
    x, y, z = at
    snowy(box((1.4 * k, 1.2 * k, 1.4 * k), (x, y + 0.6 * k, z), 0xf3f7fb, yaw=0.2), 0.5)
    snowy(box((1.05 * k, 0.9 * k, 1.05 * k), (x, y + 1.65 * k, z), 0xf3f7fb, yaw=-0.1), 0.5)
    snowy(box((0.8 * k, 0.75 * k, 0.8 * k), (x, y + 2.5 * k, z), 0xf3f7fb), 0.5)
    box((1.15 * k, 0.2 * k, 1.15 * k), (x, y + 2.12 * k, z), 0xff5040)
    box((0.45 * k, 0.16 * k, 0.16 * k), (x + 0.6 * k, y + 2.45 * k, z), 0xff7e44)
    for s2 in (-1, 1):
        box((0.08, 0.12 * k, 0.12 * k), (x + 0.41 * k, y + 2.65 * k, z + s2 * 0.18 * k), 0x2a2735)
        box((0.14, 0.14, 1.0 * k), (x, y + 1.85 * k, z + s2 * 0.95 * k), 0x7a5a3a, pitch=s2 * 0.45)
    box((0.08, 0.14 * k, 0.14 * k), (x + 0.55 * k, y + 1.75 * k, z), 0x2a2735)
    box((0.08, 0.14 * k, 0.14 * k), (x + 0.72 * k, y + 0.95 * k, z), 0x2a2735)
    if hat:
        box((0.95 * k, 0.1 * k, 0.95 * k), (x, y + 2.92 * k, z), 0x2a2735)
        box((0.6 * k, 0.55 * k, 0.6 * k), (x, y + 3.25 * k, z), 0x2a2735)

# A penguin standing at (x, y, z), beak to +X turned by yaw. Built from boxes,
# it is joined into one moving part by its caller.
def penguin(x, y, z, k, yaw):
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s2, y + dy, z - dx * s2 + dz * c)
    box((0.9 * k, 1.3 * k, 0.8 * k), at(0, 0.65 * k, 0), 0x2a2735, yaw=yaw)       # body
    box((0.2, 1.05 * k, 0.78 * k), at(0.42 * k, 0.6 * k, 0), 0xfff6eb, yaw=yaw)    # white front
    box((0.7 * k, 0.6 * k, 0.65 * k), at(0, 1.55 * k, 0), 0x2a2735, yaw=yaw)       # head
    box((0.3 * k, 0.14 * k, 0.2 * k), at(0.45 * k, 1.5 * k, 0), 0xff7e44, yaw=yaw)  # beak
    for sd in (-1, 1):
        box((0.12, 0.12, 0.12), at(0.36 * k, 1.66 * k, sd * 0.18 * k), 0xfff6eb, yaw=yaw)
        box((0.5 * k, 0.8 * k, 0.12), at(0, 0.75 * k, sd * 0.46 * k), 0x2a2735, yaw=yaw, roll=0.2)
        box((0.4 * k, 0.1, 0.24 * k), at(0.2 * k, 0.05, sd * 0.2 * k), 0xff7e44, yaw=yaw)

# A penguin tobogganing on its belly toward +X, the pivot under the middle of
# its belly: the body flat, the head up to see where it is going (the beak and
# the white face are what say "penguin" from above), flippers out like wings.
def slider_penguin(x, y, z, k):
    box((1.3 * k, 0.62 * k, 0.8 * k), (x, y + 0.31 * k, z), 0x2a2735)                    # body
    box((0.95 * k, 0.12, 0.7 * k), (x + 0.05 * k, y + 0.06, z), 0xfff6eb)                 # white belly on the ice
    box((0.62 * k, 0.6 * k, 0.62 * k), (x + 0.62 * k, y + 0.8 * k, z), 0x2a2735)          # head, up
    box((0.12, 0.42 * k, 0.48 * k), (x + 0.94 * k, y + 0.76 * k, z), 0xfff6eb)            # face
    box((0.32 * k, 0.14 * k, 0.2 * k), (x + 1.08 * k, y + 0.72 * k, z), 0xff7e44)         # beak
    for sd in (-1, 1):
        box((0.12, 0.12, 0.12), (x + 0.96 * k, y + 0.92 * k, z + sd * 0.17 * k), 0x2a2735)  # eye on the face
        box((0.55 * k, 0.1, 0.5 * k), (x - 0.05 * k, y + 0.3 * k, z + sd * 0.62 * k), 0x2a2735, pitch=sd * 0.25)  # flipper out
        box((0.3 * k, 0.1, 0.2 * k), (x - 0.78 * k, y + 0.12 * k, z + sd * 0.18 * k), 0xff7e44)  # feet behind

# The standing penguins' life (set_motion.h): rock on their feet out of step,
# turn to watch a car coming (radii in world units), hop as one passes close.
PENGUIN = 'anim_waddle+watch:r=30+hop:r=14:h=0.4#%d'

def live_penguin(n, x, y, z, k, yaw):
    with animated(PENGUIN % n, (x, y, z), yaw):
        penguin(x, y, z, k, yaw)

@piece(1.45)
def ice_chunks():
    # Glacier: a slab of floe ice beached on the snow with three penguins on
    # it, all facing +X: each placement's yaw turns that to the racer where the
    # lap reads it best (score:landmarks' `face`), a fish left on the ice. The
    # penguins are alive, each one moving part.
    snowy(box((4.6, 0.5, 3.6), (0, 0.25, 0), 0xd0e8ff, yaw=0.3), 0.4)
    live_penguin(1, 0.6, 0.5, -0.3, 1.0, 0.0)
    live_penguin(2, -0.5, 0.5, 1.0, 0.8, -0.15)
    live_penguin(3, -0.4, 0.5, -1.4, 0.7, 0.15)
    box((0.6, 0.14, 0.2), (1.6, 0.57, 1.0), 0x8ecae6, yaw=0.8)                  # the fish
    snow_heap((2.6, 0, -1.6), 1.1, yaw=0.3)

@piece(1.45)
def penguin_chute():
    # Glacier: the colony's toboggan run. Penguins pop out of a hole in the top
    # of an ice block, belly-slide down a chute toward the road (+X) and dive
    # into a hole in a floe at its foot. Under the ice they swim back to the
    # block: the path's hidden half runs inside the block and under the
    # ground, so every split cell sees them go in and come out, never jump.
    # Two more stand by the hole and watch the cars.
    ICE, SNOW, HOLE = 0xd0e8ff, 0xeef4f9, 0x38383d
    TOP = 2.85                                    # the block's snow cap
    snowy(box((2.4, 2.6, 2.4), (-3.2, 1.3, 0), ICE), 0.4)
    snowy(box((2.7, 0.25, 2.7), (-3.2, TOP - 0.125, 0), SNOW), 0.5)
    box((1.0, 0.04, 1.0), (-3.2, TOP + 0.01, 0), HOLE)
    a, b = (-2.0, TOP), (3.6, 0.47)               # the chute's running surface, lip to foot
    run, ang = math.hypot(b[0] - a[0], a[1] - b[1]), math.atan2(a[1] - b[1], b[0] - a[0])
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    def on_chute(x):
        return a[1] + (x - a[0]) * (b[1] - a[1]) / (b[0] - a[0])
    box((run, 0.12, 1.3), (mx, my - 0.06, 0), ICE, roll=ang)
    for sd in (-1, 1):
        box((run, 0.32, 0.12), (mx, my + 0.1, sd * 0.68), ICE, roll=ang)
    for px in (-0.4, 1.8):                        # snow posts under it
        hy = on_chute(px) - 0.12
        snowy(box((0.35, hy, 0.35), (px, hy / 2, 0), SNOW), 0.5)
    snowy(box((3.2, 0.45, 3.0), (5.2, 0.225, 0), ICE, yaw=0.15), 0.4)
    box((1.1, 0.04, 1.1), (5.0, 0.46, 0), HOLE, yaw=0.15)
    # the loop, piece frame: inside the block, out of its hole, along the cap
    # to the lip, down the chute, across the floe, down its hole, back under
    for k, pt in enumerate(((-3.2, -1.8, 0), (-3.2, 1.9, 0), (-3.2, TOP + 0.1, 0), (a[0], TOP + 0.02, 0),
                            (b[0], b[1] + 0.02, 0), (5.0, 0.47, 0), (5.0, -1.8, 0))):
        marker('path_chute_%d' % k, pt)
    for n in range(3):                            # spread round the loop; the renderer moves them
        x = a[0] + (b[0] - a[0]) * (0.2 + 0.3 * n)
        with animated('anim_path:c=chute:p=8.5:o=%.3f#%d' % (n / 3, n), (x, on_chute(x), 0)):
            slider_penguin(x, on_chute(x), 0, 0.75)
    live_penguin(4, 6.3, 0.45, 1.15, 0.8, -0.4)
    live_penguin(5, 4.2, 0.45, -1.2, 0.72, 0.5)

@piece(1.4)
def expedition_camp():
    # Glacier: a climbers' camp, a ridge tent closed at both ends with its door
    # toward +X, a rucksack and a long sled by it, flags on tall poles.
    for s2 in (-1, 1):
        box((3.2, 0.12, 1.9), (0, 0.72, s2 * 0.66), 0xff7e44, pitch=-s2 * 0.86)
    box((3.4, 0.14, 0.14), (0, 1.46, 0), 0x2a2735)
    for s in (-1, 1):
        prism([(1.28, 0.02), (-1.28, 0.02), (0, 1.42)], s * 1.52, 0.1, 0xff7e44)
    prism([(0.5, 0.02), (-0.5, 0.02), (0, 0.95)], 1.6, 0.06, 0x2a2735)
    box((0.5, 0.75, 0.4), (2.0, 0.38, -1.0), 0xcf534f, yaw=0.3)
    box((0.55, 0.2, 0.45), (2.0, 0.8, -1.0), 0x2a2735, yaw=0.3)
    kit('holiday', 'sled-long', (1.8, 0, 2.2), yaw=0.3, scale=1.5)
    flagpole((1.2, 0, -2.4), 3.6, 0xff5040, w=1.1, fh=0.7, wave='anim_sway:a=z:d=24:p=1.9#1')
    flagpole((-1.6, 0, 2.6), 3.0, 0xff7e44, w=1.0, fh=0.6, wave='anim_sway:a=z:d=24:p=2.2#2')
    snow_heap((-1.8, 0, -1.6), 1.5, yaw=0.9)

@piece(1.4)
def avalanche_fence():
    # Avalanche: a run of snow fence at the foot of the mountainside it guards
    # the road from, upright slats wired between posts and braced from behind
    # (-X), the snow it caught drifted along its back, pines up the slope. The
    # mountainside is the track's terrain (SET_GROUND).
    H = set_ground('avalanche-fence')
    for x, z, k in ((-10.0, -9.0, 2.4), (-14.0, 8.0, 2.6), (-6.0, 13.0, 2.2), (-22.0, -14.0, 2.4)):
        pine((x, H(x, z) - 0.3, z), k)
    L, N = 4.2, 3
    for i in range(N + 1):
        z = (i - N / 2) * L
        box((0.22, 2.4, 0.22), (0.1, 1.2, z), 0x6e4a32)
        box((0.18, 2.2, 0.18), (-0.55, 0.95, z), 0x6e4a32, roll=0.45)
    for y in (0.55, 1.75):
        box((0.08, 0.1, N * L), (0.24, y, 0), 0x555b66)
    for i in range(N):
        z0 = (i - N / 2) * L
        for k in range(6):
            box((0.08, 1.9, 0.32), (0.3, 1.1, z0 + 0.45 + k * 0.66), 0xb06041 if k % 2 else 0x8a6a46)
    snowy(box((1.6, 0.6, N * L - 0.6), (-0.9, 0.3, 0), 0xf3f7fb))
    snow_heap((-1.4, 0, -3.2), 1.6, yaw=0.4)

@piece(1.4)
def warning_sign():
    # Avalanche: a yellow diamond warning sign with a slope and its tumbling
    # snow on it, on a post beside a red and white marker pole, under the
    # rock slope it warns of, rocks that came down it lying at its foot.
    H = mound(16.0, -20.0, 0.0, 18.0, 18.5, 26.0, color=0x9aa1b4, jitter=0.7)
    for x, z, k in ((-1.6, -2.4, 0.9), (-2.2, 1.6, 1.1), (-0.8, 3.4, 0.6), (-3.4, -0.4, 0.8)):
        rock((x, H(x, z) - 0.2, z), k, yaw=x * z)
    pine((-8.0, H(-8.0, 8.0) - 0.3, 8.0), 2.2)
    box((0.2, 3.0, 0.2), (0, 1.5, 0), 0x555b66)
    box((0.1, 1.5, 1.5), (0.08, 2.6, 0), 0x2a2735, pitch=math.pi / 4)
    box((0.12, 1.3, 1.3), (0.12, 2.6, 0), 0xffc044, pitch=math.pi / 4)
    prism([(0.42, 2.32), (-0.42, 2.32), (-0.08, 2.86)], 0.2, 0.05, 0x2a2735)
    for (z, y) in ((0.28, 2.75), (0.4, 2.55), (0.18, 2.95)):
        box((0.06, 0.12, 0.12), (0.2, y, z), 0x2a2735, pitch=0.5)
    for k in range(5):
        box((0.22, 0.5, 0.22), (0, 0.25 + k * 0.5, 1.4), 0xff5040 if k % 2 == 0 else 0xfff6eb)
    snow_heap((-0.6, 0, -0.6), 1.1, yaw=0.3)

# ====================================================================================
# BACKYARD
# ====================================================================================

def strut(a, b, t, color):
    """A square bar `t` across from glTF point a to b: a ladder rail, a fork."""
    dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
    return box((t, t, math.sqrt(dx * dx + dy * dy + dz * dz)), mid, color,
               yaw=math.atan2(dx, dz), pitch=math.atan2(dy, math.hypot(dx, dz)))

# Ribbon is washing day at the scale of the garden, not of the cars: four
# lines, each a hundred units of rope between two T-posts twelve high on the
# terraces either side, strung right across the circuit, so a racer passes
# under the washing eight times a lap. Each line is its own piece, built along
# its +Z from post to post and placed by tracks.js along the line it was
# measured on. `bare` are the stretches (fractions of the line) that pass over
# Ribbon's road, with the margin a piece keeps from a deck: only rope there,
# and the rope stays well over deck + 4 (the lowest crossing is under 3.4).
# The posts stand on the plain, sunk through whatever land is under them, and
# each one's concrete pad DRAPES over that land (TtpRenderer::mSetDrapes), so
# the line levels no ground.
WASH_H, WASH_SAG = 12.5, 3.0
WASH_KINDS = [('shirt', 0xff5040), ('sheet', 0xf8f8fb), ('trousers', 0x339cf2), ('towel', 0x22c46e),
              ('shirt', 0xffc044), ('socks', 0xf8f8fb), ('towel', 0xa259e6), ('trousers', 0x555b66),
              ('shirt', 0x339cf2), ('sheet', 0xffc044), ('towel', 0xff5040), ('shirt', 0x22c46e)]

def washing_span(L, bare, seed):
    def line_y(z):
        t = (z + L / 2) / L
        return WASH_H - WASH_SAG * 4 * t * (1 - t)
    # Each post, each stretch of washing and the pads are ONE part apiece
    # (group): the bake tiles a piece by part, and a part per garment made a
    # line forty draws.
    pads = []
    for s in (-1, 1):
        z = s * L / 2
        group([box((0.55, WASH_H + 2.6, 0.55), (0, (WASH_H - 2.6) / 2, z), 0x9aa1b4),   # sunk 2.6
               box((3.2, 0.4, 0.4), (0, WASH_H + 0.2, z), 0x9aa1b4),                  # the T
               strut((0, WASH_H - 1.6, z), (1.2, WASH_H + 0.05, z), 0.3, 0x9aa1b4),
               strut((0, WASH_H - 1.6, z), (-1.2, WASH_H + 0.05, z), 0.3, 0x9aa1b4)],
              'post_%d' % (s + 1))
        pads.append(box((2.0, 0.16, 2.0), (0, 0.08, z), 0xc6cbd6))
    group(pads, 'drape_pads')
    n = int(L / 4) + 1
    tube([(0, line_y(-L / 2 + L * i / (n - 1)) + 0.15, -L / 2 + L * i / (n - 1)) for i in range(n)],
         0.17, 0xf8f8fb, res=2)
    # the washing: along every stretch that is not over road, from 2.5 off
    # each post, each piece pegged a little into the rope so it hangs from it
    K = 2.6
    free, z0 = [], -L / 2 + 2.5
    for a, b in bare:
        free.append((z0, -L / 2 + a * L))
        z0 = -L / 2 + b * L
    free.append((z0, L / 2 - 2.5))
    widths = {'shirt': 2.1, 'trousers': 1.0, 'towel': 1.2, 'socks': 0.9, 'sheet': 1.8}
    k, moving = seed * 5, 0
    for j, (a, b) in enumerate(free):
        z, hung = a, []
        while True:
            kind, col = WASH_KINDS[k % len(WASH_KINDS)]
            w = widths[kind] * K
            if z + w > b:
                break
            mid = z + w / 2
            y = line_y(mid) + 0.2
            def cloth(h, cw, dy, dz, c=col, t=0.14):
                hung.append(box((t, h * K, cw * K), (0, y - dy * K, mid + dz * K), c))
            def garment():
                if kind == 'shirt':          # a T: the body, short sleeves out at the shoulders
                    cloth(1.1, 0.9, 0.58, 0)
                    for s in (-1, 1):
                        cloth(0.36, 0.42, 0.2, s * 0.62)
                elif kind == 'trousers':     # the waistband and two legs
                    cloth(0.24, 0.9, 0.12, 0)
                    for s in (-1, 1):
                        cloth(1.25, 0.38, 0.86, s * 0.24)
                elif kind == 'towel':        # a stripe across the foot
                    cloth(1.3, 1.1, 0.65, 0)
                    cloth(0.2, 1.1, 1.05, 0, 0xf8f8fb, 0.2)
                elif kind == 'sheet':        # folded over the line, a hem at its foot
                    cloth(1.5, 1.7, 0.75, 0)
                    cloth(0.16, 1.7, 1.42, 0, 0xa0a8c9 if col == 0xf8f8fb else 0xf8f8fb, 0.2)
                else:                        # a pair of socks, toes pointing the same way
                    for s in (-1, 1):
                        cloth(0.6, 0.24, 0.3, s * 0.25)
                        cloth(0.22, 0.42, 0.5, s * 0.25 + 0.12)
            # every fourth piece flaps in the wind (about the line's own axis)
            if k % 4 == 0 and moving < 3:
                n0 = len(hung)
                with animated('anim_sway:a=z:d=%d:p=%.1f#%d' % (16 + k % 7, 2.2 + (k % 5) * 0.3, moving),
                              (0, y, mid)):
                    garment()
                del hung[n0:]
                moving += 1
            else:
                garment()
            z += w + 1.0
            k += 1
        if hung:
            group(hung, 'wash_%d' % j)

@piece(1.0)
def laundry_basket():
    # Ribbon's companion: the basket the washing came out in, at the lines'
    # scale, on the terrace at a post's foot: wicker bands, two handles, the
    # rest of the wash heaped in it and a sheet trailing over the rim, the
    # peg bag on top.
    W, H, D = 5.2, 2.4, 3.6
    for k, y in enumerate((0.3, 0.9, 1.5, 2.1)):
        c = 0xb08a5a if k % 2 == 0 else 0x9a7b55
        for s in (-1, 1):
            box((W, 0.6, 0.3), (0, y, s * (D / 2 - 0.15)), c)
            box((0.3, 0.6, D - 0.6), (s * (W / 2 - 0.15), y, 0), c)
    box((W - 0.4, H - 0.2, D - 0.4), (0, (H - 0.2) / 2, 0), 0xa0a8c9)          # the wash inside
    for s in (-1, 1):
        box((0.3, 0.7, 1.2), (s * (W / 2 + 0.05), H + 0.25, 0), 0x7a5a3a)
    for x, z, w, h, d, c in ((-1.2, -0.5, 2.0, 0.9, 1.6, 0xff5040), (0.9, 0.4, 2.2, 1.0, 1.8, 0x339cf2),
                             (-0.2, 0.6, 1.6, 0.8, 1.4, 0xf8f8fb), (1.3, -0.7, 1.4, 0.7, 1.2, 0xffc044),
                             (-1.6, 0.7, 1.2, 0.6, 1.0, 0x22c46e)):
        box((w, h, d), (x, H - 0.3 + h / 2, z), c, yaw=0.2 * x)
    box((2.4, 0.2, 0.3), (0.4, H + 0.15, D / 2 + 0.1), 0xf8f8fb)             # the sheet over the rim
    box((2.4, 1.6, 0.2), (0.4, H - 0.6, D / 2 + 0.2), 0xf8f8fb)
    box((1.0, 1.0, 0.8), (-0.6, H + 0.9, -0.3), 0xa259e6)                      # the peg bag
    for k in range(3):
        box((0.22, 0.9, 0.3), (1.6 - k * 0.5, H + 0.45, -D / 2 + 0.15), (0xff5040, 0x22c46e, 0xffc044)[k])
    group([o for o in bpy.context.scene.objects if o.type == 'MESH'], 'basket')   # one part, one draw

for _name, _L, _bare, _seed in (
        ('washing-line', 108.2, ((0.13, 0.237), (0.677, 0.802)), 0),
        ('washing-line-n', 104.9, ((0.445, 0.557), (0.675, 0.787)), 1),
        ('washing-line-b', 108.5, ((0.19, 0.318), (0.598, 0.728)), 2),
        ('washing-line-s', 108.5, ((0.403, 0.52), (0.745, 0.855)), 3)):
    PIECES[_name] = (lambda L, bare, seed: lambda: washing_span(L, bare, seed))(_L, _bare, _seed)
    GROW[_name] = 1.0

@piece(1.35)
def treehouse():
    # Pretzel: the oak grown big with a platform round its trunk, a red hut on
    # the platform's road side (+X) clear of the trunk, a ladder, a tyre swing,
    # a rope ladder, a flag and a bird box. It grew on its knoll (SET_GROUND):
    # built from its summit, then lifted onto it, the trunk sunk into it and
    # the ladder's foot on its slope.
    H = set_ground('treehouse')
    s0 = H(0.0, 0.0)
    cyl(1.0, 6.0, (0, -1.0, 0), 0x7a5a3a, r2=0.7, segs=10)
    for a, r, h in ((1.6, 0.3, 2.6), (3.2, 0.28, 2.2), (4.7, 0.25, 2.4)):     # boughs away from the hut
        o = cyl(r, h, (0, 4.2, 0), 0x7a5a3a, r2=0.1, segs=7, smooth=False)
        tilted(o, math.cos(a) * 0.8, math.sin(a) * 0.8)
    cyl(0.7, 5.0, (0, 4.6, 0), 0x7a5a3a, r2=0.45, segs=10)
    sphere(3.6, (0, 10.4, 0), 0x5f9f4a, subdiv=2)
    sphere(2.5, (-2.6, 9.2, 1.4), 0x6cae55, subdiv=2)
    sphere(2.4, (2.4, 9.4, -1.4), 0x6cae55, subdiv=2)
    sphere(2.0, (0.6, 12.2, 1.8), 0x6cae55, subdiv=2)
    sphere(1.8, (1.8, 11.6, 2.4), 0x5f9f4a, subdiv=2)
    box((5.6, 0.25, 4.6), (0, 4.4, 0), 0xb08a5a)
    for sx in (-1, 1):
        for sz in (-1, 1):
            cyl(0.07, 1.0, (sx * 2.65, 4.5, sz * 2.15), 0xb08a5a, segs=6, smooth=False)
    for sz in (-1, 1):
        box((5.5, 0.08, 0.08), (0, 5.45, sz * 2.15), 0xb08a5a)
    box((0.08, 0.08, 4.5), (-2.65, 5.45, 0), 0xb08a5a)
    # the hut: x 0.9..2.8, clear of the trunk's 0.7
    HX = 1.85
    box((1.9, 1.9, 2.0), (HX, 4.5 + 0.95, 0), 0xd94f3d)
    box((0.08, 1.2, 0.8), (HX + 0.97, 4.5 + 0.6, -0.4), 0x5a3a2a)
    box((0.08, 0.6, 0.6), (HX + 0.97, 4.5 + 1.3, 0.5), 0x8ecae6)
    for s in (-1, 1):
        box((2.3, 0.14, 1.4), (HX, 6.4 + 0.4, s * 0.55), 0xb08a5a, pitch=-s * 0.6)
    # the ladder: its foot out on the lawn (+Z), its head on the platform's edge
    for s in (-1, 1):
        x = 0.9 + s * 0.32
        strut((x, H(x, 3.6) - s0 - 0.1, 3.6), (x, 4.5, 2.3), 0.12, 0xb08a5a)
    for i in range(7):
        t = (i + 0.7) / 7.7
        box((0.7, 0.08, 0.1), (0.9, 4.5 * t, 3.5 - 1.2 * t), 0xb08a5a)
    # a tyre swing from its own bough, clear of the platform; the rope ladder
    # off the far side, a flag on the back corner, a bird box
    strut((0.0, 7.4, -0.2), (-4.0, 7.8, -2.8), 0.36, 0x7a5a3a)
    with animated('anim_sway:a=x:d=24:p=2.8', (-3.6, 7.6, -2.55)):      # the tyre swings
        tube([(-3.6, 7.6, -2.55), (-3.6, 1.6, -2.55)], 0.03, 0x9a7b55, res=2, bevel_res=0)
        torus(0.55, 0.18, (-3.6, 1.1, -2.55), 0x2a2735, axis='across')
    for i in range(6):
        box((0.5, 0.05, 0.1), (-1.0, 0.6 + i * 0.7, 2.6), 0xb08a5a)
    for s in (-0.25, 0.25):
        tube([(-1.0 + s, 4.5, 2.4), (-1.0 + s, 0.4, 2.7)], 0.025, 0x9a7b55, res=2, bevel_res=0)
    flagpole((-2.65, 4.5, -2.15), 2.8, 0x22c46e, pole=0xb08a5a, wave='anim_sway:a=z:d=20:p=1.5')
    box((0.5, 0.6, 0.5), (0.9, 3.2, 0.2), 0xb08a5a)
    box((0.5, 0.1, 0.6), (0.9, 3.55, 0.2), 0xd94f3d)
    disc(0.08, (1.16, 3.3, 0.2), 0x2a2735, segs=8, h=0.02)
    for o in bpy.context.scene.objects:          # onto the summit
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw) for n, (x, y, z), yaw in ANIMS]

# Tangle: one hose at the scale of the garden, from the tap on the east lawn,
# under the bridge of the S-bend, round the middle lawn, under the first
# bridge and over the north lawn to the sprinkler on the west (its own piece,
# the hero). PATH is the hose's line in this piece's frame (tracks.js places
# it at heading 0, so these are the world's axes), measured clear of Tangle's
# road except where a deck passes high over it. Yellow, so it reads on the
# lawn. Every part DRAPES (TtpRenderer::mSetDrapes): the renderer lays it on
# the lawn as drawn, over the humps it crosses, and the piece levels no ground.
HOSE_PATH = [(26.0, -33.0), (21.0, -32.0), (16.0, -30.0), (11.0, -27.0), (6.0, -25.5), (2.0, -24.0),
             (-2.0, -21.0), (-4.0, -16.0), (-3.0, -9.0), (-7.0, -6.0), (-12.0, -10.0), (-18.0, -7.0),
             (-20.0, 0.0), (-15.0, 3.0), (-9.0, 6.0), (-8.0, 12.0), (-9.0, 18.0), (-13.0, 23.0),
             (-20.0, 27.0), (-25.0, 33.0), (-31.0, 30.0), (-36.0, 35.0), (-42.0, 31.0), (-44.0, 24.0),
             (-49.0, 20.0), (-49.5, 14.0), (-51.4, 9.6)]
HOSE_R = 0.6

@piece(1.0)
def garden_hose():
    Y = 0xffc044
    # the tap: a standpipe on a slab, a red wheel handle, the hose's coupling
    # pointing west along the hose
    tx, tz = 30.0, -35.0
    parts = [box((2.4, 0.3, 2.4), (tx, 0.15, tz), 0x9aa1b4),
             box((0.8, 4.0, 0.8), (tx, 2.0, tz), 0x9aa1b4),
             cyl(0.4, 1.3, (tx, 3.2, tz), 0x9aa1b4, segs=8, axis='across', yaw=math.pi),
             cyl(0.8, 0.25, (tx, 4.3, tz), 0xff5040, segs=10),
             box((0.3, 0.6, 0.3), (tx, 4.0, tz), 0x9aa1b4),
             cyl(0.65, 0.7, (tx - 1.3, 3.2, tz), 0x22c46e, segs=8, axis='across', yaw=math.pi)]
    # the hose: out of the coupling, down to the lawn, then the PATH
    pts = [(tx - 2.0, 3.2, tz), (tx - 3.0, 1.4, tz + 0.6)]
    pts += [(x, HOSE_R, z) for x, z in HOSE_PATH]
    parts.append(tube(pts, HOSE_R, Y, res=3, smooth=True))
    # its far end: the coupling it screws onto the sprinkler with
    ex, ez = HOSE_PATH[-1]
    parts.append(box((1.3, 1.3, 1.3), (ex, HOSE_R, ez), 0x22c46e))
    # the reel cart by the tap, a few turns of the hose still on its drum
    rx, rz = 30.0, -28.0
    for s in (-1, 1):
        parts.append(cyl(1.6, 0.3, (rx + s * 1.2, 1.9, rz), 0x22c46e, segs=12, axis='across'))
        parts.append(box((0.3, 2.0, 0.3), (rx + s * 1.4, 1.0, rz + 0.9), 0x9aa1b4))
        parts.append(box((0.3, 2.0, 0.3), (rx + s * 1.4, 1.0, rz - 0.9), 0x9aa1b4))
    parts.append(cyl(1.1, 2.4, (rx - 1.2, 1.9, rz), Y, segs=12, axis='across'))
    parts.append(box((3.1, 0.3, 0.3), (rx, 2.05, rz - 0.9), 0x9aa1b4))
    group(parts, 'drape_hose')

def water_stream(at, a, reach, rise, n=7, t=0.3):
    """A jet as one unbroken stream from the nozzle `at` out along heading `a`
    (from +X toward +Z), `reach` away where it meets the ground, arcing `rise`
    over a straight drop: n links, each overlapping the next."""
    x0, y0, z0 = at
    def p(t):
        return (x0 + math.cos(a) * reach * t, y0 * (1 - t) + 4 * rise * t * (1 - t), z0 + math.sin(a) * reach * t)
    for k in range(n):
        strut(p(max(0.0, k / n - 0.02)), p(min(1.0, (k + 1) / n + 0.02)), t, 0xd0e8ff)

@piece(1.5)
def playground():
    # Cloverleaf: swings, slide, seesaw and a sandpit with a bucket.
    H = 4.0
    for z in (-2.4, 2.4):
        for s in (-1, 1):
            o = cyl(0.1, H + 0.2, (s * 1.1, 0, z), 0x339cf2, segs=8, smooth=False)
            tilted(o, 0, -s * 0.26)
    box((0.22, 0.22, 5.4), (0, H, 0), 0x339cf2)
    for n, z in enumerate((-1.0, 1.0)):
        with animated('anim_sway:a=z:d=28:p=2.6#%d' % n, (0, H, z)):          # swinging from the bar
            for s in (-1, 1):
                # chains in the frame's grey: black ones read as a barred wall
                tube([(0, H - 0.1, z + s * 0.45), (0, 1.0, z + s * 0.45)], 0.025, 0x9aa1b4, res=2)
            box((0.5, 0.08, 1.2), (0, 0.95, z), 0xff5040)
    X = 3.6
    for s in (-1, 1):
        box((0.08, 2.6, 0.08), (X + 1.4, 1.3, s * 0.45), 0x9aa1b4)
    for i in range(5):
        box((0.08, 0.06, 0.9), (X + 1.4, 0.35 + i * 0.55, 0), 0x9aa1b4)
    box((1.2, 0.12, 1.2), (X + 0.7, 2.6, 0), 0x9aa1b4)
    for s in (-1, 1):
        box((0.1, 0.9, 1.2), (X + 0.7 + s * 0.6, 3.05, 0), 0x9aa1b4)
    box((0.1, 0.9, 0.1), (X + 0.7, 3.05, 0.6), 0x9aa1b4)
    chute_len = 4.2
    box((1.0, 0.1, chute_len), (X + 0.7, 2.6 - 1.2, -0.6 - chute_len / 2 * math.cos(0.6)), 0xff5040, pitch=0.6)
    for s in (-1, 1):
        box((0.06, 0.3, chute_len), (X + 0.7 + s * 0.5, 2.6 - 1.05, -0.6 - chute_len / 2 * math.cos(0.6)), 0xff5040, pitch=0.6)
    # the seesaw rocks on its fulcrum
    box((0.3, 0.6, 0.6), (-4.0, 0.3, 0), 0x339cf2)
    with animated('anim_sway:a=x:d=11:p=2.4', (-4.0, 0.7, 0)):
        box((0.4, 0.1, 4.4), (-4.0, 0.7, 0), 0x22c46e)
        for s2 in (-1, 1):
            box((0.5, 0.12, 0.5), (-4.0, 0.81, s2 * 2.0), 0xff5040)
            box((0.1, 0.4, 0.1), (-4.0, 0.95, s2 * 1.7), 0x9aa1b4)
    # the roundabout turns
    box((0.5, 0.3, 0.5), (-1.0, 0.15, -4.6), 0x9aa1b4)
    with animated('anim_spin:w=0.9', (-1.0, 0.3, -4.6)):
        cyl(1.5, 0.15, (-1.0, 0.3, -4.6), 0xffc044, segs=12)
        cyl(0.12, 1.0, (-1.0, 0.45, -4.6), 0x9aa1b4, segs=6)
        for k in range(4):
            a = k * math.pi / 2
            strut((-1.0, 1.4, -4.6), (-1.0 + math.cos(a) * 1.3, 0.95, -4.6 + math.sin(a) * 1.3), 0.1, 0xff5040)
            box((0.1, 0.5, 0.1), (-1.0 + math.cos(a) * 1.3, 0.7, -4.6 + math.sin(a) * 1.3), 0xff5040)
    # sandpit with a bucket and spade
    for s in (-1, 1):
        box((3.2, 0.3, 0.2), (-1.0, 0.15, 4.5 + s * 1.5), 0xb08a5a)
        box((0.2, 0.3, 3.2), (-1.0 + s * 1.5, 0.15, 4.5), 0xb08a5a)
    box((2.8, 0.2, 2.8), (-1.0, 0.1, 4.5), 0xe6d29a)
    cyl(0.28, 0.4, (-0.4, 0.2, 4.2), 0xff5040, r2=0.22, segs=8)
    box((0.06, 0.6, 0.18), (-1.6, 0.5, 4.9), 0x339cf2, roll=0.6)

@piece(1.5)
def paddling_pool():
    # Pretzel's support: a blue inflatable pool, a floating ring, a duck, a
    # towel and a slide into it.
    torus(2.4, 0.5, (0, 0.5, 0), 0x339cf2, segs=20, minor=8)
    disc(2.2, (0, 0.45, 0), 0x62d3c8, segs=24, h=0.1)
    torus(0.6, 0.18, (-0.6, 0.6, 0.4), 0xff5040, segs=14)
    with animated('anim_bob:h=0.18:p=2.6', (0.9, 0.5, -0.6)):              # the duck rides the ripples
        sphere(0.3, (0.9, 0.7, -0.6), 0xf2c14e, subdiv=1, scale=(1, 0.8, 1.3))
        sphere(0.2, (0.9, 1.0, -0.9), 0xf2c14e, subdiv=1)
        box((0.14, 0.06, 0.2), (0.9, 1.0, -1.1), 0xff5040)
    box((1.8, 0.05, 1.0), (3.4, 0.03, 1.6), 0x22c46e, yaw=0.2)
    # the slide: a ladder up to a little deck, a walled chute down over the rim
    box((1.0, 0.1, 2.6), (-1.6, 1.6, -2.8), 0xff5040, pitch=-0.5)
    for s in (-1, 1):
        box((0.1, 0.3, 2.6), (-1.6 + s * 0.5, 1.72, -2.8), 0xff5040, pitch=-0.5)
        strut((-1.6 + s * 0.45, 0.0, -4.75), (-1.6 + s * 0.45, 2.3, -4.15), 0.12, 0x9aa1b4)
    for i in range(4):
        t = (i + 1) / 5
        box((0.9, 0.08, 0.1), (-1.6, 2.3 * t, -4.75 + 0.6 * t), 0x9aa1b4)
    box((1.0, 0.1, 0.5), (-1.6, 2.2, -4.15), 0x9aa1b4)
    cyl(0.3, 0.45, (3.0, 0, -1.4), 0xa259e6, r2=0.25, segs=8)

@piece(1.5)
def bird_bath():
    # Cloverleaf's support: a bird bath on a pedestal, a bird on the rim, a
    # ring of flowers round it.
    cyl(0.6, 0.2, (0, 0, 0), 0x9aa1b4, segs=10)
    cyl(0.25, 1.4, (0, 0.2, 0), 0x9aa1b4, r2=0.2, segs=10)
    cyl(0.5, 0.3, (0, 1.6, 0), 0x9aa1b4, r2=1.0, segs=14)
    disc(0.85, (0, 1.9, 0), 0x7db8e8, segs=14, h=0.04)
    sphere(0.16, (0.8, 2.0, 0), 0x339cf2, subdiv=1, scale=(1, 0.8, 1.4))
    sphere(0.1, (0.8, 2.2, 0.2), 0x339cf2, subdiv=1)
    torus(2.0, 0.25, (0, 0.1, 0), 0x7a5a3a, segs=14)
    for k in range(9):
        a = k / 9 * 2 * math.pi
        cyl(0.04, 0.5, (math.cos(a) * 2.0, 0.2, math.sin(a) * 2.0), 0x2bb673, segs=4, smooth=False)
        sphere(0.2, (math.cos(a) * 2.0, 0.75, math.sin(a) * 2.0), [0xff5040, 0xa259e6, 0xf2c14e, 0xfff6eb][k % 4], subdiv=1)

@piece(1.5)
def barbecue():
    # Cloverleaf's support: a kettle grill with sausages on the grate and its
    # lid swung open; a table, two chairs and a cooler.
    cyl(0.35, 0.45, (0, 0.5, 0), 0x2a2735, r2=0.7, segs=12)          # the kettle
    disc(0.64, (0, 0.95, 0), 0x555b66, segs=12, h=0.04)                # the grate
    for k in range(3):
        a = k * 2 * math.pi / 3 + 0.5
        strut((math.cos(a) * 0.65, 0, math.sin(a) * 0.65), (math.cos(a) * 0.25, 0.6, math.sin(a) * 0.25), 0.1, 0x555b66)
    for k in range(3):
        box((0.16, 0.14, 0.55), (-0.25 + k * 0.25, 1.05, 0), 0xd94f3d)
    # the lid, swung up on its hinge at the back of the rim
    th = 1.1
    o = cyl(0.7, 0.32, (-0.7 + 0.7 * math.cos(th), 0.97 + 0.7 * math.sin(th), 0), 0x2a2735, r2=0.35, segs=12)
    tilted(o, 0, -th)
    box((1.8, 0.08, 1.2), (-2.4, 0.75, 0), 0xb08a5a)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.08, 0.75, 0.08), (-2.4 + sx * 0.8, 0.375, sz * 0.5), 0xb08a5a)
    for s in (-1, 1):
        box((0.5, 0.06, 0.5), (-2.4, 0.5, s * 1.2), 0x339cf2)
        box((0.5, 0.5, 0.06), (-2.4, 0.78, s * 1.45), 0x339cf2)
        for sx in (-1, 1):
            box((0.05, 0.5, 0.05), (-2.4 + sx * 0.2, 0.25, s * 1.0), 0x9aa1b4)
    box((0.9, 0.6, 0.6), (0.4, 0.3, -1.8), 0x339cf2)
    box((0.95, 0.1, 0.65), (0.4, 0.65, -1.8), 0xfff6eb)

def goal(z, face):
    """A little goal on the line at `z`, its mouth toward +Z (face 1) or -Z
    (face -1). The net is open cord, never a sheet (a sheet reads as a glass
    roof): a lattice sloping from the crossbar to the ground bar behind, and
    across each side."""
    before = set(bpy.context.scene.objects)
    W, H, D = 3.6, 1.8, 1.3
    NET = 0xd0e8ff
    for x in (-W / 2, W / 2):                     # built mouth to +X, then turned
        box((0.16, H, 0.16), (0, H / 2, x), 0xfff6eb)
        box((D, 0.12, 0.12), (-D / 2, 0.06, x), 0xfff6eb)
        strut((-0.05, H - 0.05, x), (-D, 0.06, x), 0.12, 0xfff6eb)
        strut((-D / 2, 0.06, x), (-D / 2, H / 2, x), 0.07, NET)
        box((D / 2, 0.07, 0.07), (-D / 4, H / 2, x), NET)
    box((0.16, 0.16, W + 0.16), (0, H, 0), 0xfff6eb)
    box((0.12, 0.12, W), (-D, 0.06, 0), 0xfff6eb)
    for k in (1, 2):
        t = k / 3
        box((0.07, 0.07, W), (-D * t, H * (1 - t), 0), NET)
    for k in range(1, 4):
        x = -W / 2 + W * k / 4
        strut((-0.05, H - 0.05, x), (-D, 0.06, x), 0.07, NET)
    bpy.context.view_layer.update()
    # glTF +X to +Z is a quarter turn about up (Blender Z), then to the line
    turn = Matrix.Translation(P(0, 0, z)) @ Matrix.Rotation(-face * math.pi / 2, 4, 'Z')
    for o in set(bpy.context.scene.objects) - before:
        o.matrix_world = turn @ o.matrix_world

@piece(1.45)
def football_pitch():
    # Pretzel: a kickabout on the lawn laid along the road: two little goals
    # facing each other across the grass, the ball between them.
    L = 14.0
    goal(-L / 2, 1)
    goal(L / 2, -1)
    sphere(0.36, (0.6, 0.36, 1.2), 0xfff6eb, subdiv=1)

@piece(1.45)
def trampoline():
    # Pretzel: a round trampoline on six legs, a ball left on the mat.
    torus(1.9, 0.12, (0, 1.0, 0), 0x339cf2, segs=12)
    disc(1.7, (0, 0.98, 0), 0x2a2735, segs=12, h=0.05)
    for k in range(6):
        a = k / 6 * 2 * math.pi
        box((0.16, 1.0, 0.16), (math.cos(a) * 1.9, 0.5, math.sin(a) * 1.9), 0x555b66)
    with animated('anim_bob:h=1.6:p=1.1', (0.5, 1.0, -0.4)):                # a ball left bouncing
        sphere(0.4, (0.5, 1.4, -0.4), 0xff5040, subdiv=1)

@piece(1.0)
def sprinkler():
    # Tangle's hero: the rotary sprinkler at the end of the hose, at the
    # garden's scale: a heavy sled, a riser taller than a car is long, and a
    # head of three arms turning, each throwing a stream of water out over the
    # lawn it has soaked. The hose screws on at its back (-X).
    disc(10.5, (0, 0.0, 0), 0x22c46e, segs=16, h=0.05)                  # the soaked lawn
    for x, z, r in ((6.5, 3.0, 1.6), (-3.5, 6.0, 1.2), (2.0, -7.0, 1.8)):
        disc(r, (x, 0.05, z), 0x62d3c8, segs=10, h=0.05)                # puddles
    for s in (-1, 1):
        box((5.0, 0.5, 0.7), (0, 0.25, s * 1.6), 0xffc044)               # the sled's runners
    box((3.2, 0.6, 3.2), (0, 0.75, 0), 0x22c46e)
    cyl(0.9, 0.6, (0, 1.05, 0), 0x9aa1b4, segs=10)
    box((1.6, 0.7, 0.9), (-1.9, 0.75, 0), 0x9aa1b4)                        # the inlet
    cyl(0.5, 1.2, (-3.1, 0.7, 0), 0xffc044, segs=8, axis='across')
    box((0.8, 5.6, 0.8), (0, 4.2, 0), 0x9aa1b4)                            # the riser
    cyl(0.75, 0.6, (0, 6.9, 0), 0x555b66, segs=10)
    H = 7.5
    with animated('anim_spin:w=-1.1', (0, H, 0)):                        # the head turns, streams and all
        cyl(1.0, 0.9, (0, H - 0.1, 0), 0xffc044, segs=10)
        box((0.9, 0.9, 0.9), (0, H + 1.1, 0), 0xff5040)
        for k in range(3):
            a = 0.3 + k * 2 * math.pi / 3
            tip = (math.cos(a) * 3.4, H + 1.0, math.sin(a) * 3.4)
            strut((0, H + 0.4, 0), tip, 0.5, 0xffc044)
            box((0.7, 0.7, 0.7), tip, 0x339cf2, yaw=-a)
            water_stream((tip[0] * 1.08, tip[1] + 0.1, tip[2] * 1.08), a, 6.8, 1.6)

@piece(1.45)
def picnic_blanket():
    # Cloverleaf: a red and white checked blanket, a wicker basket with its
    # lid shut and its handle up, plates and a bottle.
    box((2.4, 0.04, 2.0), (0, 0.02, 0), 0xff5040)
    for i in range(3):
        for j in range(3):
            if (i + j) % 2 == 0:
                box((0.8, 0.05, 0.667), (-0.8 + i * 0.8, 0.03, -0.667 + j * 0.667), 0xfff6eb)
    box((0.8, 0.45, 0.55), (-0.5, 0.27, 0.45), 0xb08a5a)
    box((0.86, 0.08, 0.6), (-0.5, 0.52, 0.45), 0x9a7b55)
    for s in (-1, 1):
        strut((-0.5 + s * 0.3, 0.52, 0.45), (-0.5 + s * 0.2, 0.92, 0.45), 0.08, 0x9a7b55)
    box((0.5, 0.08, 0.08), (-0.5, 0.92, 0.45), 0x9a7b55)
    for x, z in ((0.55, -0.55), (0.6, 0.4)):
        disc(0.26, (x, 0.05, z), 0xfff6eb, segs=10, h=0.04)
    cyl(0.1, 0.5, (-0.2, 0.04, -0.5), 0x2bb673, segs=6)

# ====================================================================================
# CANYON
# ====================================================================================

TIMBER, BONE, ROPE = 0x8a5f3e, 0xf8f8fb, 0x2a2735

class plain_parts:
    """The parts built inside stay square-edged. At a real thing's size a
    post, a rail, a cow's leg is a few hundredths of a unit across, where
    the chamfer cannot be seen and only multiplies the part's triangles by
    almost four; the same holds for rough rock, whose blocks are big but
    whose edges no one reads as made."""
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        return self
    def __exit__(self, *exc):
        for o in bpy.context.scene.objects:
            if o not in self.before:
                o['chamfer'] = 0
        return False

def plain(fn):
    """A builder whose every part is built inside plain_parts."""
    def build():
        with plain_parts():
            fn()
    build.__name__ = fn.__name__
    return build

def footbridge(at, span=4.0, w=1.6):
    """Timber planks over a creek, crossing ALONG +Z: a stone sill on each bank
    that the deck lands on, a gentle arch between, posts and a rail each side."""
    x, y, z = at
    for sz in (-1, 1):
        box((w + 0.5, 0.36, 0.8), (x, y + 0.18, z + sz * (span / 2 + 0.2)), 'grey')
    n = 9
    for k in range(n):
        t = (k - (n - 1) / 2) / ((n - 1) / 2)
        box((w, 0.12, span / n + 0.02), (x, y + 0.42 + (1 - t * t) * 0.3, z + t * (span / 2 - span / n / 2)),
            TIMBER, pitch=-t * 0.22)
    for sx in (-1, 1):
        for sz in (-1, 0, 1):
            h = 1.15 + (0.3 if sz == 0 else 0.0)
            box((0.16, h, 0.16), (x + sx * (w / 2 + 0.02), y + 0.36 + h / 2 - 0.1, z + sz * (span / 2 - 0.1)), TIMBER)
        for z0, z1 in ((-1, 0), (0, 1)):
            a, b = z + z0 * (span / 2 - 0.1), z + z1 * (span / 2 - 0.1)
            ya, yb = y + 1.4 + (0.3 if z0 == 0 else 0.0), y + 1.4 + (0.3 if z1 == 0 else 0.0)
            L = math.hypot(b - a, yb - ya)
            box((0.12, 0.12, L), (x + sx * (w / 2 + 0.02), (ya + yb) / 2, (a + b) / 2), TIMBER,
                pitch=math.atan2(yb - ya, b - a))

def ore_cart(at, yaw=0.0, ore=True, ore_color=0xa8623f):
    """A mine cart on rails along its local Z: a tub on four wheels, ore heaped
    in it."""
    x, y, z = at
    c, sn = math.cos(yaw), math.sin(yaw)
    def at2(dx, dy, dz):
        return (x + dx * c + dz * sn, y + dy, z - dx * sn + dz * c)
    box((1.3, 0.8, 1.9), at2(0, 0.85, 0), 'grey', yaw=yaw)
    box((1.4, 0.12, 2.0), at2(0, 1.25, 0), 'slate', yaw=yaw)
    for sx in (-1, 1):
        for sz in (-1, 1):
            cyl(0.26, 0.16, at2(sx * 0.6 - (0.16 if sx > 0 else 0), 0.3, sz * 0.6), ROPE, segs=8, axis='across', yaw=yaw)
    if ore:
        for k, (dx, dz) in enumerate(((0.2, -0.4), (-0.25, 0.1), (0.15, 0.5))):
            box((0.6, 0.4, 0.6), at2(dx, 1.35, dz), ore_color if k != 1 else 0xa8623f, yaw=yaw + 0.5 * k)

def ground_poly(verts, faces, color):
    """Flat faces on the ground, drawn from ABOVE only: poly()'s back faces
    would be coplanar and fight the front ones for the depth test, the
    underside's dark light winning half the pixels."""
    me = bpy.data.meshes.new('ground')
    me.from_pydata([tuple(P(*v)) for v in verts], [], faces)
    me.update()
    for p in me.polygons:
        if p.normal.z < 0:
            p.flip()
    o = bpy.data.objects.new('ground', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def tumbleweed(at, r):
    """A ball of dry scrub: two faceted shells of one size, one turned in the
    other, so their corners poke through each other's faces and it reads
    twiggy rather than solid. Plain icosahedra: one this small would come out
    of sphere() as a block."""
    for rr, color, sy, yaw in ((r, 0xb8a686, 1.0, 0.0), (r * 0.97, 0x8a6a46, 1.08, 0.63)):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=rr)
        o = bpy.context.active_object
        o.scale = (1.0, 1.0, sy)
        o.location = P(*at)
        o.rotation_euler = (0, 0, yaw)
        bpy.ops.object.shade_flat()
        paint(o, color)

def sandstone_rock(at, k=1.0, yaw=0.0, color=0xc07a55):
    """A low red-rock boulder: two blocks, one tipped on the other."""
    x, y, z = at
    box((1.4 * k, 0.7 * k, 1.1 * k), (x, y + 0.35 * k, z), color, yaw=yaw)
    box((0.8 * k, 0.5 * k, 0.7 * k), (x + 0.2 * k, y + 0.85 * k, z - 0.1 * k), 0xd39a70, yaw=yaw + 0.6, roll=0.12)

@piece(1.45)
def dry_creek():
    # Wash: the stretch of the dry wash nearest the road. The creek itself is
    # the track's land (tracks.js wash `land`: a plain wound across the map,
    # left unraised under the bridges); this piece's SET_GROUND holds the same
    # floor under it and a low cut bank either side. A pale gravel bed along X
    # between dark banks, stones on the bars, a dead cottonwood of a tree's
    # size on the bank. Tumbleweeds, each half a car high, blow down it: each rolls out of the
    # rock pile at the upwind end, bowls the length of the bed bouncing and
    # vanishes into the pile at the far end; the hidden half of the loop runs
    # back under the ground (anim_path+spin+bob).
    L, W, BANK = 54.0, 3.0, 0.45
    zc = lambda x: 0.9 * math.sin(x / 6.5)                       # a wander inside the land's plain
    def wid(x):
        t = min(1.0, abs(x) / (L / 2))
        return W * max(0.0, 1 - t ** 3.0) ** 0.8
    N = 40
    def across(x):
        dz = 0.9 / 6.5 * math.cos(x / 6.5)
        nl = math.hypot(1.0, dz)
        return -dz / nl, 1.0 / nl
    def ribbon(half, y, color):
        verts, faces = [], []
        for i in range(N + 1):
            x = -L / 2 + L * i / N
            nx, nz = across(x)
            w = half(x)
            verts += [(x + nx * w, y, zc(x) + nz * w), (x - nx * w, y, zc(x) - nz * w)]
            if i:
                faces.append((2 * i - 2, 2 * i - 1, 2 * i + 1, 2 * i))
        ground_poly(verts, faces, color)
    ribbon(lambda x: wid(x) / 2 + BANK * wid(x) / W, 0.03, 'brown')    # the cut banks
    ribbon(lambda x: wid(x) / 2, 0.07, 'cream')                        # the gravel bed
    tones = ['grey', 'lavender', 'white', 'tan']
    for i in range(20):
        x = -L / 2 * 0.9 + L * 0.9 * (i + 0.5) / 20
        f = wid(x) / W
        nx, nz = across(x)
        off = (((i * 7) % 5) - 2) / 2.0 * max(wid(x), 0.6) * 0.42
        r = 0.32 + 0.3 * f + 0.1 * ((i * 3) % 3)
        box((r, 0.25 + 0.15 * f, r * 0.8), (x + nx * off, 0.12, zc(x) + nz * off), tones[i % 4], yaw=i * 0.7)
    END = L / 2 - 1.5
    for sx in (-1, 1):                                                 # the rock piles the weeds roll from and into
        x = sx * END
        sandstone_rock((x, 0, zc(x) - 0.2), 1.7, yaw=0.5 + sx)
        sandstone_rock((x + sx * 1.0, 0, zc(x) + 1.0), 1.3, yaw=1.6 - sx)
    group([o for o in bpy.context.scene.objects if o.type == 'MESH'], 'bed')   # one draw
    dead_tree((-6.0, 0, zc(-6.0) + 4.4), h=3.0, r=0.17)
    sandstone_rock((-4.4, 0, zc(-4.4) + 3.2), 0.8, yaw=0.4)
    sandstone_rock((10.0, 0, zc(10.0) + 3.0), 0.7, yaw=1.2)
    # the tumbleweeds' loop: down the bed at its own height, then back under it
    R = 0.17
    xs = [-END + 2 * END * i / 12 for i in range(13)]
    for k, pt in enumerate([(x, R, zc(x)) for x in xs] + [(END, -1.9, zc(END)), (-END, -1.9, zc(-END))]):
        marker('path_weed_%d' % k, pt)
    for n in range(3):
        x = xs[2 + 3 * n]
        with animated('anim_path:c=weed:p=30:o=%.3f:f=1+spin:a=z:w=-16+bob:h=0.08:p=0.5#%d' % (n / 3, n),
                      (x, R, zc(x))):
            tumbleweed((x, R, zc(x)), R)

@piece(1.0)
def wash_bed():
    # Wash: one reach of the dry wash's gravel bed, the floor of the channel
    # its own SET_GROUND cuts between low banks (the plain it lies on). Placed
    # end to end, each reach overlapping the next, the bed winds across the
    # whole map and under the bridges where the road crosses it; the hero
    # (dry-creek) is the stretch by the north straight. 38 units along Z,
    # ragged, fading to stones at both ends where the next reach takes over;
    # ONE mesh (group), so a reach is one draw wherever it is seen.
    L, N = 38.0, 20
    def half(z):
        t = abs(z) / (L / 2)
        return (2.5 + 0.45 * math.sin(z * 0.7) + 0.3 * math.sin(z * 1.9 + 1.0)) * max(0.0, 1 - t ** 4) ** 0.5
    def ribbon(extra, y, color):
        verts, faces = [], []
        for i in range(N + 1):
            z = -L / 2 + L * i / N
            w = half(z) + extra * half(z) / 2.5
            verts += [(w, y, z), (-w, y, z)]
            if i:
                faces.append((2 * i - 2, 2 * i - 1, 2 * i + 1, 2 * i))
        ground_poly(verts, faces, color)
    ribbon(0.5, 0.03, 'brown')
    ribbon(0.0, 0.07, 'cream')
    tones = ['grey', 'lavender', 'white', 'tan']
    for i, (x, z, r) in enumerate(((0.8, -12.0, 0.5), (-1.2, -6.0, 0.4), (0.3, 1.0, 0.6),
                                   (1.4, 7.5, 0.35), (-0.6, 12.5, 0.5), (-1.9, -0.8, 0.3))):
        box((r, 0.2 + 0.2 * r, r * 0.8), (x, 0.1, z), tones[i % 4], yaw=i * 0.9)
    group([o for o in bpy.context.scene.objects if o.type == 'MESH'], 'bed')

@piece(0.35)
def mine_portal():
    # Gulch: the mine, at the size of the thing (the builder works in units of
    # 1/0.35 of the world's): the adit's timber portal a car high, cut into the
    # blocky face of a rock spur (the face natural and big, the piece's
    # SET_GROUND ridge rising behind it, -X, the track's own ridge beyond); a
    # narrow-gauge line runs out of it toward the road (+X) under the tipple (a
    # bin on a trestle, its spout over a cart) to a buffer stop. The ore line
    # branches off it just outside the adit (set-ore-line, on this piece's
    # anchor at this piece's grow), and its train comes out of the dark of the
    # adit. The powder shed stands upstream (-Z), its flag flapping; the yard
    # in front is the plain the SET_GROUND levels.
    with plain_parts():
        for (x, y, z, sx, sy, sz, c, yw) in (
                (-6.6, 3.6, -4.4, 4.2, 7.2, 4.0, 0xa96545, 0.2),     # the buttresses either side
                (-6.4, 3.4, 4.4, 4.0, 6.8, 4.0, 0xc47a52, -0.3),
                (-10.8, 5.4, -1.0, 6.0, 10.8, 10.0, 0xb4714d, 0.15), # the spur's face behind
                (-9.6, 3.0, 9.0, 6.2, 6.0, 6.0, 0xa96545, 0.5),      # its flanks
                (-9.2, 2.3, -9.6, 5.6, 4.6, 6.0, 0xc47a52, -0.4)):
            box((sx, sy, sz), (x, y, z), c, yaw=yw)
        box((1.4, 3.0, 2.6), (-5.0, 1.5, 0), ROPE)                                   # the adit
        for z in (-1.5, 1.5):
            box((0.5, 3.6, 0.5), (-4.1, 1.8, z), TIMBER)
        box((0.6, 0.5, 4.2), (-4.1, 3.75, 0), TIMBER)
        for z in (-2.4, 2.4):                                                        # lamps either side
            box((0.2, 2.4, 0.2), (-3.0, 1.2, z), 'slate')
            box((0.4, 0.4, 0.4), (-3.0, 2.5, z), 'yellow')
        for z in (-0.6, 0.6):                                                        # the line
            box((17.4, 0.2, 0.2), (4.4, 0.3, z), 'slate')
        for k in range(9):
            box((1.8, 0.2, 0.5), (-3.6 + k * 2.0, 0.1, 0), TIMBER)
        box((0.6, 0.9, 1.8), (13.3, 0.45, 0), TIMBER)                                # buffer stop
        box((0.3, 0.3, 2.2), (13.0, 0.75, 0), 'red')
        with plain_parts():
            ore_cart((6.0, 0.3, 0), yaw=math.pi / 2, ore_color='yellow')             # loading under the tipple
        # the tipple: a trestle over the line, the bin on its deck, a funnel under
        # the deck with its spout over the cart, a ladder up one leg
        for sx in (-1, 1):
            for sz in (-1, 1):
                box((0.4, 4.4, 0.4), (6.0 + sx * 1.6, 2.2, sz * 1.6), TIMBER)
            box((0.2, 0.2, 3.6), (6.0 + sx * 1.6, 2.6, 0), TIMBER, pitch=0.62)
        box((3.8, 0.3, 3.8), (6.0, 4.4, 0), TIMBER)
        box((3.2, 1.8, 3.2), (6.0, 5.45, 0), 0x9a7b55)
        box((3.5, 0.24, 3.5), (6.0, 6.45, 0), 'slate')
        box((1.5, 0.8, 1.5), (6.0, 3.85, 0), 0x9a7b55)
        box((0.7, 0.6, 0.7), (6.0, 3.15, 0), 0x9a7b55)
        for s in (-1, 1):
            box((0.2, 4.4, 0.2), (7.85, 2.2, -1.2 + s * 0.3), TIMBER)
        for i in range(6):
            box((0.2, 0.2, 0.6), (7.85, 0.5 + i * 0.7, -1.2), TIMBER)
        for k, (x, z) in enumerate(((8.6, 2.2), (9.4, 2.8), (8.9, 3.4))):            # gold ore spilled by the tipple
            box((0.55, 0.4, 0.55), (x, 0.2, z), 'yellow' if k % 2 == 0 else 0xa8623f, yaw=0.6 * k)
    # the powder shed, set back from the line, crates of powder by the door
    hut(2.6, 2.0, 2.4, (1.4, 0, -6.8), TIMBER, 'slate')
    for k, (x, z, y) in enumerate(((3.4, -5.5, 0), (3.4, -6.5, 0), (3.4, -6.0, 0.8))):
        box((0.9, 0.8, 0.9), (x, y + 0.4, z), 0x9a7b55, yaw=0.1 * k)
    for k in range(4):
        box((0.16, 0.16, 0.6), (3.2 + k * 0.16, 1.7, -6.0), 'red')
    flagpole((-0.4, 0, -8.8), 3.4, 'red', w=1.0, fh=0.6, wave='anim_sway:a=z:d=24:p=2.0#1')

@piece(0.35)
@plain
def ore_line():
    # Gulch: the mine's narrow-gauge line, placed on the mine portal's own
    # anchor (this frame and grow are the portal's). It branches off the
    # portal's line just outside the adit, winds out of the yard along the
    # start straight and round the east bend, and ends at the headframe's
    # collar (placed to meet it). Its SET_GROUND is the cutting it lies in, one
    # plain per chord of the route; the rails run on a smooth curve through the
    # chords' ends, the portal's gauge and sleepers. A little train rides it
    # (anim_path, each wagon facing its way): a mine loco hauling three carts
    # of gold ore out of the dark of the adit, the length of the line at a
    # mine train's walking pace, onto the collar and down the shaft, home
    # under the ground. Cut in three runs (groups), so a cell draws only the
    # runs it sees.
    k = GROW['ore-line']
    pts = []
    for f in SET_GROUND['set-ore-line']:
        th = math.radians(f['yaw'])
        s, c = math.sin(th), math.cos(th)
        cx, cz = f['x'] * c + f['z'] * s, -f['x'] * s + f['z'] * c     # its offset is in its turned frame
        h = f['len'] / 2
        if not pts:
            pts.append(((cx - s * h) / k, (cz - c * h) / k))
        pts.append(((cx + s * h) / k, (cz + c * h) / k))
    # Catmull-Rom through them: out of the portal's line along +X, into the
    # collar along the last chord
    ext = ([(pts[1][0] - 2 * math.dist(pts[0], pts[1]), pts[1][1])] + pts
           + [(2 * pts[-1][0] - pts[-2][0], 2 * pts[-1][1] - pts[-2][1])])
    curve = [pts[0]]
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        n = max(1, math.ceil(math.dist(p1, p2) / 1.0))
        for j in range(1, n + 1):
            t = j / n
            curve.append(tuple(0.5 * (2 * p1[a] + (p2[a] - p0[a]) * t
                                      + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t * t
                                      + (3 * p1[a] - p0[a] - 3 * p2[a] + p3[a]) * t ** 3) for a in (0, 1)))
    acc = [0.0]
    for a, b in zip(curve, curve[1:]):
        acc.append(acc[-1] + math.dist(a, b))
    total = acc[-1]
    def on(s):
        """The point and the heading at `s` along the curve."""
        i = 0
        while i < len(curve) - 2 and acc[i + 1] < s:
            i += 1
        a, b = curve[i], curve[i + 1]
        d = max(1e-6, acc[i + 1] - acc[i])
        t = min(1.0, max(0.0, (s - acc[i]) / d))
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), ((b[0] - a[0]) / d, (b[1] - a[1]) / d)
    RAIL, TIE, Y = 12.0, 5.5, 0.3                                # a rail chord, the sleepers' spacing, rail height
    nr = max(3, math.ceil(total / RAIL))
    ss = [total * i / nr for i in range(nr + 1)]
    for run in range(3):
        before = set(bpy.context.scene.objects)
        i0, i1 = nr * run // 3, nr * (run + 1) // 3
        for i in range(i0, i1):
            (pa, da), (pb, db) = on(ss[i]), on(ss[i + 1])
            for sd in (-1, 1):
                strut((pa[0] + da[1] * 0.6 * sd, Y, pa[1] - da[0] * 0.6 * sd),
                      (pb[0] + db[1] * 0.6 * sd, Y, pb[1] - db[0] * 0.6 * sd), 0.2, 'slate')
        s = ss[i0] + TIE / 2
        while s < ss[i1]:
            p, d = on(s)
            box((1.8, 0.2, 0.5), (p[0], 0.1, p[1]), TIMBER, yaw=math.atan2(d[0], d[1]))
            s += TIE
        group([o for o in bpy.context.scene.objects if o not in before and o.type == 'MESH'], 'line%d' % run)
    # the train's loop: up out of the ground behind the adit, out along the
    # portal's line, the length of this one, onto the headframe's collar (0.81
    # world on from the line's end, the headframe standing 1.26 on) and down
    # the shaft, then home under everything
    CO = 0.81 / k
    loop = [(-8.0, -3.0, 0.0), (-5.2, Y, 0.0)]
    loop += [(p[0], Y, p[1]) for p in (on(s)[0] for s in ss)]
    (ex, ez), (dx, dz) = on(total)
    loop += [(ex + dx * CO, Y + 0.25, ez + dz * CO), (ex + dx * CO, -12.0, ez + dz * CO)]
    for i, p in enumerate(loop):
        marker('path_ore_%d' % i, p)
    # a mine train's pace: about 2 world units a second round the whole loop
    span = sum(math.dist(a, b) for a, b in zip(loop, loop[1:] + loop[:1])) * k
    period = span / 2.0
    gap = 2.4 / (span / k)                                       # a wagon's length and its coupling, of the loop
    x0, z0 = pts[0]
    with animated('anim_path:c=ore:p=%.1f:o=0:f=1#0' % period, (x0, Y, z0)):
        mine_loco((x0, Y, z0), yaw=math.pi / 2)
    for n in range(1, 4):
        with animated('anim_path:c=ore:p=%.1f:o=%.4f:f=1#%d' % (period, 1.0 - n * gap, n), (x0, Y, z0)):
            ore_cart((x0, Y, z0), yaw=math.pi / 2, ore_color='yellow')

def mine_loco(at, yaw=0.0):
    """A little battery loco for the mine line, along its local Z (its front
    +Z): a low green body on four wheels, a cab at the back with a roof on
    posts, a lamp on the nose."""
    x, y, z = at
    c, sn = math.cos(yaw), math.sin(yaw)
    def at2(dx, dy, dz):
        return (x + dx * c + dz * sn, y + dy, z - dx * sn + dz * c)
    box((1.2, 0.7, 2.0), at2(0, 0.75, 0.1), 0x3fa14e, yaw=yaw)
    box((1.3, 0.12, 2.2), at2(0, 0.42, 0.1), 'slate', yaw=yaw)
    for sx in (-1, 1):
        box((0.12, 0.9, 0.12), at2(sx * 0.5, 1.55, -0.75), 'slate', yaw=yaw)
    box((1.3, 0.14, 1.0), at2(0, 2.05, -0.6), 'red', yaw=yaw)
    box((0.4, 0.3, 0.2), at2(0, 1.0, 1.15), 'yellow', yaw=yaw)
    for sx in (-1, 1):
        for sz in (-1, 1):
            cyl(0.26, 0.16, at2(sx * 0.6 - (0.16 if sx > 0 else 0), 0.3, 0.1 + sz * 0.6), ROPE, segs=8, axis='across', yaw=yaw)

@piece(1.0)
def telegraph_line():
    # Sidewinder: a telegraph line straight across the desert along the long
    # straight (+-Z), its poles a real pole's height (two car lengths) and
    # stood clear of the road (the offsets come from the track: see the
    # piece's set entry), crossarms ACROSS the line, three wires sagging
    # between poles. Where the figure-eight's two strands cross the line
    # (the gap in the poles) it carries no wire: at a real pole's height a
    # span would hang across the low road at the driver's eye and thread
    # under the overpass. Each end pole is stayed by a guy wire to an anchor, and
    # the line drops into a lineman's hut at its far end; a highway sign
    # faces the oncoming traffic by the straight. Grouped in runs of four
    # spans, a draw each, so a cell draws only the runs it sees.
    zs = [-122, -106, -90, -74, -42, -26, -10, 6, 22, 38, 54, 70, 86, 102, 118, 134, 150]
    H = 1.9
    arm = (-0.32, 0.0, 0.32)
    for r0 in range(0, len(zs), 4):
        before = set(bpy.context.scene.objects)
        for z in zs[r0:r0 + 4]:
            cyl(0.06, H, (0, 0, z), TIMBER, r2=0.05, segs=6, smooth=False)
            box((0.86, 0.1, 0.1), (0, H - 0.2, z), TIMBER)
        for x in arm:
            for z0, z1 in zip(zs[r0:r0 + 4], zs[r0 + 1:r0 + 5]):
                if z1 - z0 > 16:                         # the road crosses the gap: no wire over it
                    continue
                tube(sag((x, H - 0.05, z0), (x, H - 0.05, z1), 0.012 * (z1 - z0), n=3), 0.025, ROPE,
                     res=1, bevel_res=0, wire=True)
        group([o for o in bpy.context.scene.objects if o not in before and o.type == 'MESH'], 'run%d' % r0)
    for z, d in ((zs[0], -1), (zs[-1], 1)):                                      # the stays
        dy, dz = 0.1 - (H - 0.3), d * 1.3
        box((0.04, 0.04, math.hypot(dy, dz)), (0, (H - 0.3 + 0.1) / 2, z + dz / 2), ROPE, pitch=math.atan2(dy, dz))
        box((0.18, 0.12, 0.18), (0, 0.06, z + d * 1.35), TIMBER)
    hut(1.2, 0.85, 1.1, (1.3, 0, zs[-1] + 1.0), 0x9a7b55, 'slate', yaw=math.pi / 2)   # the lineman's hut
    tube(sag((0.32, H - 0.05, zs[-1]), (1.3, 1.1, zs[-1] + 1.0), 0.1, n=4), 0.025, ROPE, res=2, bevel_res=0, wire=True)
    box((0.1, 0.9, 0.1), (-0.8, 0.45, -4.0), 'slate')                            # the highway sign
    box((0.06, 0.4, 0.6), (-0.8, 1.05, -4.0), 0xd9b054)
    box((0.07, 0.08, 0.42), (-0.77, 1.05, -4.0), ROPE)

@piece(0.47)
@plain
def dead_cottonwood():
    # Wash's support: a lone dead cottonwood a tree's height on the bank, a
    # vulture perched on its top looking out at the road, a fallen limb, red
    # rocks and a tumbleweed at its foot (the builder's units are 1/0.47 of
    # the world's).
    dead_tree((0, 0, 0), h=9.5, color=0x8a6a46)
    o = cyl(0.2, 3.6, (1.2, 0.2, 1.0), 0x8a6a46, r2=0.1, segs=5, axis='along', smooth=False)
    o.rotation_euler.z = 0.6
    vy, k = 9.5, 1.0                                                             # the vulture
    def v(size, d, color, pitch=0.0):
        box([s * k for s in size], (d[0] * k, vy + d[1] * k, d[2] * k), color, pitch=pitch)
    v((0.7, 0.6, 0.55), (0, 0.42, 0), 'dark')
    for sd in (-1, 1):
        v((0.8, 0.5, 0.12), (-0.08, 0.48, sd * 0.33), 'slate')
    v((0.5, 0.12, 0.4), (-0.5, 0.25, 0), 'dark')
    v((0.36, 0.16, 0.46), (0.22, 0.74, 0), 'white')
    v((0.16, 0.26, 0.16), (0.3, 0.92, 0), 'salmon')
    v((0.32, 0.24, 0.26), (0.4, 1.1, 0), 'red')
    v((0.2, 0.1, 0.12), (0.62, 1.06, 0), 'cream')
    for sd in (-1, 1):
        v((0.12, 0.12, 0.08), (0.48, 1.16, sd * 0.13), 'dark')
    sandstone_rock((-2.6, 0, -1.6), 1.1, yaw=1.2)
    sandstone_rock((2.8, 0, -2.6), 0.8, yaw=0.2)
    tumbleweed((-1.8, 0.5, 2.2), 0.5)
    join_still('tree')

def windpump_body(x0, z0, k, tag=''):
    """An old farm windpump at (x0, z0), `k` the size of the 7 unit one: a
    wooden tower braced corner to corner, the wheel of narrow wooden blades
    up top facing +X with its tail vane behind, the pump rod down the middle
    to the pump head, its spout over a plank trough at the foot. The wheel
    turns (anim_spin)."""
    H = 7.0 * k
    WOOD, BLADE = 0x8a6a46, 'tan'
    def leg(sx, sz, y):                                                          # a leg's corner at height y
        w = (0.8 - y / k * 0.07) * k
        return (x0 + sx * w, y, z0 + sz * w)
    for sx in (-1, 1):
        for sz in (-1, 1):
            strut(leg(sx, sz, 0.0), leg(sx, sz, H), 0.2 * k, WOOD)
    for y0, y1 in ((0.3 * k, 3.6 * k), (3.6 * k, 6.8 * k)):                     # the X braces, front and back
        for a, b in (((1, 1), (1, -1)), ((-1, -1), (-1, 1))):
            strut(leg(*a, y0), leg(*b, y1), 0.12 * k, WOOD)
    for y in (0.3 * k, 6.8 * k):                                                  # the girts
        w = (0.8 - y / k * 0.07) * k
        for s2 in (-1, 1):
            box((2 * w + 0.12 * k, 0.12 * k, 0.12 * k), (x0, y, z0 + s2 * w), WOOD)
            box((0.12 * k, 0.12 * k, 2 * w + 0.12 * k), (x0 + s2 * w, y, z0), WOOD)
    cy = H + 0.25 * k
    box((1.0 * k, 0.5 * k, 0.5 * k), (x0 + 0.05 * k, cy, z0), 'slate')         # the head
    with animated('anim_spin:a=x:w=1.4' + tag, (x0 + 0.66 * k, cy, z0)):          # the wheel turns
        box((0.3 * k, 0.3 * k, 0.3 * k), (x0 + 0.62 * k, cy, z0), 'red')        # the hub
        for b in range(8):                                                       # the blades
            a = b / 8 * 2 * math.pi
            box((0.06 * k, 1.2 * k, 0.3 * k), (x0 + 0.66 * k, cy + math.sin(a) * 0.95 * k, z0 + math.cos(a) * 0.95 * k),
                BLADE, pitch=-(math.pi / 2 - a))
        torus(1.5 * k, 0.07 * k, (x0 + 0.68 * k, cy, z0), WOOD, segs=12, axis='across')
    box((1.8 * k, 0.12 * k, 0.12 * k), (x0 - 1.2 * k, cy, z0), WOOD)            # the tail
    box((1.0 * k, 0.8 * k, 0.08 * k), (x0 - 2.3 * k, cy, z0), 'cream')
    box((0.08 * k, H - 0.6 * k, 0.08 * k), (x0, (H - 0.6 * k) / 2 + 0.3 * k, z0), 'slate')   # the pump rod
    box((0.36 * k, 0.7 * k, 0.36 * k), (x0, 0.35 * k, z0), 'slate')
    box((1.6 * k, 0.14 * k, 0.14 * k), (x0 + 0.8 * k, 0.6 * k, z0), 'slate')
    box((1.0 * k, 0.55 * k, 2.2 * k), (x0 + 1.9 * k, 0.27 * k, z0), WOOD)       # the trough
    box((0.8 * k, 0.05 * k, 2.0 * k), (x0 + 1.9 * k, 0.56 * k, z0), 0x62d3c8)

@piece(0.42)
def windpump():
    # Crag: a windpump out on the range at a stock trough, a tree's height
    # (the builder's units are 1/0.42 of the world's), its wheel turning: the
    # ranch's water reaching every part of the lap.
    windpump_body(0.0, 0.0, 1.0)
    join_still('pump')

def cow(at, yaw=0.0, coat=0x8a5a3c, life=None):
    """A cow the size of one beside a car (about a car long), facing +X
    turned by `yaw`: a block of a body on its legs, a white patch, a white
    face lowered to graze, short horns. `life` names the head's motion (a
    nod as it grazes), hinged at the neck."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def p(dx, dy, dz):
        return (x + dx * c + dz * s, y + dy, z - dx * s + dz * c)
    for lx in (-0.27, 0.24):                                                    # the legs, a pair to a block
        box((0.1, 0.28, 0.3), p(lx, 0.14, 0), 0x5a4632, yaw=yaw)
    box((0.78, 0.34, 0.38), p(-0.02, 0.44, 0), coat, yaw=yaw)                    # the body
    box((0.3, 0.24, 0.4), p(-0.12, 0.47, 0), 0xf8f8fb, yaw=yaw)                 # a white patch
    def head():
        box((0.3, 0.22, 0.22), p(0.5, 0.4, 0), 0xf8f8fb, yaw=yaw, roll=-0.5)    # the face, lowered to graze
        box((0.12, 0.12, 0.17), p(0.68, 0.28, 0), 0xf2bf99, yaw=yaw)            # the muzzle
        box((0.08, 0.06, 0.4), p(0.46, 0.53, 0), 0xfde4c7, yaw=yaw)             # the horns
    if life:
        with animated(life, p(0.36, 0.5, 0), yaw):
            head()
    else:
        head()

def hay_bale(at, yaw=0.0):
    x, y, z = at
    box((0.6, 0.32, 0.4), (x, y + 0.16, z), 'yellow', yaw=yaw)
    box((0.62, 0.05, 0.08), (x, y + 0.33, z), 'brown', yaw=yaw)

@piece(1.0)
def ranch():
    # Crag: the mesa ranch, every building at its own size beside a car (the
    # builder works in world units): the ranch house with its porch and
    # chimney, the red barn with hay stacked by it, the water tower on its
    # braced legs, the windpump turning over its stock tank, and the corral in
    # front toward the road (+X) with cattle in it, one of them grazing; all
    # on a dirt yard.
    ground_poly([(-7.4, 0.03, -8.6), (3.8, 0.03, -8.6), (3.8, 0.03, 8.8), (-7.4, 0.03, 8.8)], [(0, 1, 2, 3)], 0xd39a70)
    # the house, door toward the road, a porch along its front
    hut(3.0, 1.2, 2.4, (-4.2, 0, -3.8), 0xe3cfa4, 0x8a4a32)
    box((0.9, 0.1, 2.8), (-2.25, 1.15, -3.8), 0x8a4a32, roll=-0.25)
    for z in (-4.95, -3.8, -2.65):
        box((0.1, 1.1, 0.1), (-1.9, 0.55, z), TIMBER)
    box((0.4, 0.9, 0.4), (-5.2, 1.9, -4.6), 0xa96545)                           # the chimney
    # the barn, red with white trim, hay by its door
    hut(3.4, 1.8, 3.0, (-4.4, 0, 4.0), 0xb5443a, 'slate')
    for k, (x, z, y, yw) in enumerate(((-2.2, 5.6, 0, 0.1), (-2.2, 6.3, 0, -0.1), (-2.25, 5.95, 0.32, 0.0))):
        hay_bale((x, y, z), yw)
    # the water tower beside the house
    tx, tz = 1.0, -6.6
    for sx in (-1, 1):
        for sz in (-1, 1):
            strut((tx + sx * 0.62, 0, tz + sz * 0.62), (tx + sx * 0.48, 2.0, tz + sz * 0.48), 0.14, TIMBER)
    for s in (-1, 1):
        strut((tx + s * 0.6, 0.2, tz - 0.6), (tx + s * 0.5, 1.8, tz + 0.5), 0.08, TIMBER)
        strut((tx - 0.6, 0.2, tz + s * 0.6), (tx + 0.5, 1.8, tz + s * 0.5), 0.08, TIMBER)
    box((1.4, 0.12, 1.4), (tx, 2.02, tz), TIMBER)
    cyl(0.72, 1.0, (tx, 2.08, tz), 0x9a7b55, segs=12)
    for y in (2.3, 2.75):
        cyl(0.75, 0.07, (tx, y, tz), 0x5a4632, segs=12)
    cyl(0.84, 0.55, (tx, 3.08, tz), 0x6e5b3a, r2=0.08, segs=12)
    box((0.12, 1.9, 0.12), (tx + 0.5, 0.95, tz + 0.2), 'slate')                # its downpipe to a trough
    box((0.5, 0.3, 0.9), (tx + 1.0, 0.15, tz + 0.2), TIMBER)
    for i in range(5):                                                           # a ladder up a leg
        box((0.06, 0.06, 0.34), (tx - 0.62, 0.35 + i * 0.36, tz - 0.3), TIMBER)
    # the windpump over the stock tank, across the yard
    windpump_body(1.6, 6.8, 0.42, tag='#w')
    cyl(0.75, 0.32, (2.6, 0, 6.8), 'grey', segs=12)
    cyl(0.68, 0.04, (2.6, 0.3, 6.8), 0x62d3c8, segs=12)
    # the corral toward the road: posts and two rails, its gate open on +X
    X0, X1, Z0, Z1 = -1.4, 3.2, -2.0, 2.0
    posts = [(X0 + (X1 - X0) * i / 2, Z0) for i in range(3)] + [(X1, Z0 + (Z1 - Z0) * i / 4) for i in range(1, 5)] \
        + [(X1 - (X1 - X0) * i / 2, Z1) for i in range(1, 3)] + [(X0, 0.0)]
    for x, z in posts:
        box((0.12, 0.5, 0.12), (x, 0.25, z), TIMBER)
    loop = posts + posts[:1]
    for a, b in zip(loop, loop[1:]):
        if a[0] == X1 and b[0] == X1 and min(a[1], b[1]) >= 0.0 and max(a[1], b[1]) <= 1.0:
            continue                                                             # the gateway
        L = math.dist(a, b)
        for y in (0.2, 0.42):
            box((0.05, 0.07, L), ((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2), 0x9a7b55, yaw=math.atan2(b[0] - a[0], b[1] - a[1]))
    box((0.05, 0.07, 1.0), (X1 + 0.45, 0.32, 1.0), 0x9a7b55, yaw=1.2)             # the gate, swung open
    box((0.5, 0.25, 1.1), (X0 + 0.5, 0.12, -1.2), 'grey')                         # a trough, a hay feeder
    box((0.4, 0.03, 1.0), (X0 + 0.5, 0.25, -1.2), 0x62d3c8)
    hay_bale((X0 + 0.6, 0, 1.2), 0.3)
    cow((0.4, 0, -0.6), yaw=0.4)
    cow((1.7, 0, 0.9), yaw=2.6, coat=0x5a3a28, life='anim_sway:a=z:d=14:p=3.4#c')
    cow((2.2, 0, -1.2), yaw=-1.2, coat=0xf8f8fb)
    join_still('ranch')

@piece(1.0)
def cattle():
    # Crag: a few head of the ranch's cattle out on the range by a salt lick,
    # each a car long; two of them grazing (their heads nod).
    cow((0.0, 0, 0.0), yaw=0.3, life='anim_sway:a=z:d=14:p=3.1#a')
    cow((-1.4, 0, 1.3), yaw=2.4, coat=0x5a3a28)
    cow((-0.6, 0, -1.6), yaw=-0.9, coat=0xf8f8fb, life='anim_sway:a=z:d=12:p=3.7#b')
    box((0.3, 0.24, 0.3), (-0.9, 0.12, 0.1), 'white')                           # the salt lick
    join_still('herd')

def hoodoo(x, z, h, k, yaw=0.0):
    """A hoodoo: a spire of soft banded rock under a hard dark cap, wider at
    the foot, `h` tall and `k` across, its tiers turned a little each."""
    tiers = ((0.0, 0.4, 1.0, 0xc47a52), (0.4, 0.3, 0.74, 0xd68f62), (0.7, 0.2, 0.52, 0xe3cfa4))
    for i, (y0, f, w, col) in enumerate(tiers):
        box((w * k, f * h, w * k * 0.9), (x, (y0 + f / 2) * h, z), col, yaw=yaw + 0.25 * i)
    box((0.95 * k, 0.1 * h, 0.85 * k), (x, 0.95 * h, z), 0x8a4a32, yaw=yaw + 0.4)   # the cap

@piece(1.0)
def hoodoos():
    # Crag: a field of hoodoos, spires of banded red rock under dark caps
    # (natural and big: two to six units tall), with tumbled blocks between.
    for i, (x, z, h, k) in enumerate(((0.0, 0.0, 5.6, 1.6), (2.6, 2.0, 3.8, 1.2), (-2.2, 2.8, 4.6, 1.4),
                                      (1.8, -2.6, 3.2, 1.1), (4.4, -0.6, 2.2, 0.9), (-4.0, 0.2, 3.4, 1.2),
                                      (-1.4, -3.6, 2.4, 1.0))):
        hoodoo(x, z, h, k, yaw=0.7 * i)
    for i, (x, z, s) in enumerate(((1.4, 0.6, 0.6), (-2.8, -1.4, 0.5))):
        box((s * 1.4, s * 0.8, s), (x, s * 0.4, z), 0xa96545, yaw=0.9 * i)
    join_still('hoodoos')

@piece(1.0)
def butte():
    # Crag: a butte, a lone flat-topped stack of banded red rock (natural, a
    # small hill's size, eight and a half units tall), its sheer walls stepped where the
    # softer bands weather back, a hard dark caprock, and the blocks that
    # fell from it on the scree at its foot. Its long side faces +X.
    for (y0, h, sx, sz, col, yw) in ((0.0, 3.0, 12.0, 8.4, 0xa96545, 0.0), (3.0, 2.0, 11.2, 7.8, 0xc47a52, 0.03),
                                     (5.0, 1.3, 10.8, 7.4, 0xe3cfa4, -0.02), (6.3, 1.5, 10.4, 7.2, 0xd68f62, 0.02),
                                     (7.8, 0.7, 11.0, 7.8, 0x8a4a32, 0.0)):
        box((sz, h, sx), (0, y0 + h / 2, 0), col, yaw=yw)
    for (x, z, sx, sy, sz, yw) in ((4.2, 3.6, 2.6, 5.4, 3.0, 0.2), (-3.8, -4.4, 3.0, 6.6, 3.4, -0.3),
                                   (4.0, -5.0, 2.2, 4.2, 2.8, 0.5)):
        box((sx, sy, sz), (x, sy / 2, z), 0xb4714d, yaw=yw)                     # buttresses breaking the walls
    for i, (x, z, s) in enumerate(((5.6, 1.0, 1.4), (5.2, -2.4, 1.0), (-5.4, 2.2, 1.2), (1.4, 6.8, 1.1),
                                   (-1.8, -7.0, 1.3), (6.2, 4.6, 0.8))):
        box((s * 1.5, s * 0.8, s * 1.2), (x, s * 0.3, z), 0xa96545, yaw=0.8 * i, roll=0.15)
    join_still('butte')

@piece(1.0)
@plain
def canyon_wall():
    # Wash: a length of the slot canyon's wall (12 units along Z), the face
    # toward the road (+X), five units tall and more, its strata in bands
    # that step back as they go up, the blocks of each band jutting and
    # receding along it, boulders fallen at its foot. It DRAPES: every vertex
    # rides the land under it, so the foot follows the canyon floor and the
    # back runs into the ridge behind (the track's own land).
    L, D = 12.0, 4.0
    bands = ((0.0, 1.5, 0xa96545), (1.5, 1.1, 0xd68f62), (2.6, 1.3, 0xb4714d), (3.9, 0.8, 0xe3cfa4),
             (4.7, 1.3, 0xa96545), (6.0, 0.5, 0x8a4a32))
    for bi, (y0, h, col) in enumerate(bands):
        n = 4
        for k in range(n):
            z = -L / 2 + L * (k + 0.5) / n
            jut = (((k * 7 + bi * 3) % 5) - 2) * 0.16
            box((D, h, L / n + 0.25), (-D / 2 + jut - bi * 0.14, y0 + h / 2, z), col,
                yaw=(((k + bi) % 3) - 1) * 0.05)
    for i, (z, s) in enumerate(((-4.2, 0.7), (-0.6, 0.5), (3.4, 0.8))):
        box((s * 1.4, s * 0.8, s * 1.1), (0.5 + s * 0.4, s * 0.4, z), 0xa96545, yaw=0.7 * i)
    group([o for o in bpy.context.scene.objects if o.type == 'MESH'], 'drape_wall')

@piece(1.0)
def filling_station():
    # Sidewinder: the filling station on the desert highway, at its own size
    # beside a car: the shop with its door to the road (+X), a canopy over
    # two pumps in front of it, a stack of tyres and oil drums, and the tall
    # sign by the road turning on its pole (anim_spin).
    hut(2.6, 1.2, 2.0, (-2.2, 0, 0), 0xf2efe6, 0xc0392b)
    box((0.1, 0.3, 1.6), (-0.85, 1.05, 0), 0xc0392b)                             # its name board
    for sx in (0.2, 2.6):
        for sz in (-1.1, 1.1):
            box((0.14, 1.4, 0.14), (sx, 0.7, sz), 'white')
    box((3.0, 0.2, 2.8), (1.4, 1.5, 0), 'white')                                 # the canopy
    box((3.06, 0.12, 2.86), (1.4, 1.36, 0), 0xc0392b)
    with plain_parts():
        for z in (-0.5, 0.5):                                                        # the pumps on their island
            box((0.3, 0.6, 0.26), (1.4, 0.38, z), 0xc0392b)
            box((0.32, 0.12, 0.28), (1.4, 0.72, z), 'white')
            box((0.06, 0.06, 0.06), (1.58, 0.5, z), 'dark')
        box((0.6, 0.08, 1.6), (1.4, 0.04, 0), 'grey')
        for k, (x, z) in enumerate(((-0.6, 1.4), (-0.3, 1.6), (-0.9, 1.7))):          # oil drums
            cyl(0.13, 0.34, (x, 0, z), 0x3f6fd1 if k % 2 else 0xc0392b, segs=8)
        for i in range(3):                                                           # a stack of tyres
            cyl(0.2, 0.1, (-0.7, i * 0.1, -1.5), ROPE, segs=8)
        box((0.14, 3.0, 0.14), (2.6, 1.5, -2.6), 'slate')                            # the sign's pole
        with animated('anim_spin:a=y:w=0.9#s', (2.6, 3.3, -2.6)):
            box((0.12, 0.6, 1.2), (2.6, 3.3, -2.6), 0xc0392b)
            box((0.16, 0.2, 0.9), (2.6, 3.35, -2.6), 'white')
            box((0.18, 0.12, 0.12), (2.6, 3.7, -2.6), 'yellow')
    join_still('station')

@piece(0.45)
@plain
def headframe():
    # Gulch: the far end of the mine's ore line, where a shaft goes straight
    # down: a timber headframe over the shaft collar at a real one's height
    # (about six car lengths; the builder's units are 1/0.45 of the world's),
    # its back legs braced toward the hoist house (-X) the cable comes from,
    # the sheave wheel on top turning as the cage winds (anim_spin), the
    # cable over it and down to the cage; the ore line (set-ore-line) runs up
    # to the collar from +X, and its train rolls onto the collar and down the
    # shaft.
    H = 9.0
    box((3.6, 0.4, 3.4), (1.0, 0.2, 0), TIMBER)                                  # the collar
    box((2.4, 0.06, 2.4), (1.0, 0.42, 0), 'dark')
    for sx in (-1, 1):                                                           # four legs, leaning in
        for sz in (-1, 1):
            strut((sx * 1.6, 0, sz * 1.4), (sx * 0.8, H, sz * 0.8), 0.34, TIMBER)
    for y in (3.0, 6.0):                                                         # girts
        w, wz = 1.6 - 0.8 * y / H, 1.4 - 0.6 * y / H
        for s in (-1, 1):
            box((2 * w + 0.3, 0.22, 0.22), (0, y, s * wz), TIMBER)
            box((0.22, 0.22, 2 * wz + 0.3), (s * w, y, 0), TIMBER)
    for s in (-1, 1):                                                            # braces on the sides
        strut((-1.6, 0.3, s * 1.4), (1.07, 5.9, s * 1.0), 0.16, TIMBER)
    for sz in (-1, 1):                                                           # the back legs
        strut((-6.2, 0, sz * 1.1), (-0.7, H - 0.4, sz * 0.8), 0.32, TIMBER)
        strut((-3.4, 0, sz * 1.0), (-3.0, 4.4, sz * 0.95), 0.2, TIMBER)
    box((2.8, 0.3, 2.4), (0, H, 0), TIMBER)                                      # the sheave deck
    cy = H + 1.75
    for sz in (-1, 1):
        box((0.3, 1.9, 0.3), (0, H + 0.95, sz * 0.75), TIMBER)
    box((0.3, 0.3, 1.9), (0, cy, 0), 'slate')                                    # the axle
    with animated('anim_spin:a=z:w=-1.5', (0, cy, 0)):                          # the wheel turns
        torus(1.45, 0.14, (0, cy, 0), 'red', segs=16, axis='along')
        for k in range(4):
            box((0.2, 2.8, 0.2), (0, cy, 0), 'red', roll=k * math.pi / 4)
        box((0.55, 0.55, 0.5), (0, cy, 0), 'slate')
    strut((-7.4, 2.4, 0), (-1.0, cy + 1.1, 0), 0.12, ROPE)                     # the cable from the drum
    strut((1.45, cy, 0), (1.45, 2.95, 0), 0.12, ROPE)                           # and down to the cage
    box((1.0, 1.1, 1.0), (1.45, 2.4, 0), 'slate')                                # the cage, over the carts
    hut(3.6, 2.6, 3.4, (-8.8, 0, 0), TIMBER, 'slate')                            # the hoist house
    box((0.45, 1.8, 0.45), (-9.9, 3.8, 1.0), 'slate')
    for s in (-1, 1):                                                            # a ladder up a leg, clear of the carts
        box((0.12, 6.0, 0.12), (1.9, 3.0, -1.2 + s * 0.25), TIMBER)
    for i in range(7):
        box((0.12, 0.1, 0.5), (1.9, 0.6 + i * 0.8, -1.2), TIMBER)

# ====================================================================================
# PLAYROOM
# ====================================================================================

def quad(pts, color, parent=None):
    """One flat face through four glTF points, counter-clockwise seen from the
    side it shows: paint on a surface (a letter on a block, a pip on a domino).
    With `parent`, the points are in that object's own frame."""
    me = bpy.data.meshes.new('quad')
    me.from_pydata([tuple(P(*v)) for v in pts], [], [(0, 1, 2, 3)])
    me.update()
    o = bpy.data.objects.new('quad', me)
    bpy.context.scene.collection.objects.link(o)
    if parent is not None:
        o.parent = parent
    return paint(o, color)

# a face of a box: (outward normal, the viewer's right), both glTF
FACES = {'+x': ((1, 0, 0), (0, 0, -1)), '-x': ((-1, 0, 0), (0, 0, 1)),
         '+z': ((0, 0, 1), (1, 0, 0)), '-z': ((0, 0, -1), (-1, 0, 0))}

def plate_x(x, y0, y1, z0, z1, color):
    """A painted rectangle facing +X (the road) at `x`."""
    return quad([(x, y0, z1), (x, y0, z0), (x, y1, z0), (x, y1, z1)], color)

def merge_paint():
    """Join the painted faces of a piece into one object per swatch, so a run
    of letters or pips costs a node, not one each."""
    groups = {}
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and o.name.startswith('quad'):
            groups.setdefault(o['swatch'], []).append(o)
    for objs in groups.values():
        if len(objs) < 2:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()

def face_rect(o, face, d, u0, u1, v0, v1, color):
    """A painted rectangle on `face` of `o`, `d` out from its centre, u along
    the viewer's right and v up (both in o's frame)."""
    n, r = FACES[face]
    pts = [tuple(n[i] * d + r[i] * u + (v if i == 1 else 0) for i in range(3))
           for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]
    return quad(pts, color, parent=o)

# block letters on a 5 x 5 grid: (col0, row0, col1, row1) bars, row 0 at the foot
GLYPH = {
    'A': ((0, 0, 0, 4), (4, 0, 4, 4), (1, 4, 3, 4), (1, 2, 3, 2)),
    'B': ((0, 0, 0, 4), (1, 4, 3, 4), (1, 2, 3, 2), (1, 0, 3, 0), (4, 3, 4, 3), (4, 1, 4, 1)),
    'C': ((0, 1, 0, 3), (1, 4, 4, 4), (1, 0, 4, 0)),
    'D': ((0, 0, 0, 4), (1, 4, 3, 4), (1, 0, 3, 0), (4, 1, 4, 3)),
    'E': ((0, 0, 0, 4), (1, 4, 4, 4), (1, 2, 3, 2), (1, 0, 4, 0)),
    'H': ((0, 0, 0, 4), (4, 0, 4, 4), (1, 2, 3, 2)),
    'L': ((0, 0, 0, 4), (1, 0, 4, 0)),
    'T': ((0, 4, 4, 4), (2, 0, 2, 3)),
}
ABC = 'ABCDEHLT'

def block(size, at, color, yaw=0.0, roll=0.0, pitch=0.0, letters=None, faces=('+x', '-x', '+z', '-z', '+y')):
    """An alphabet block: a coloured cube with a cream panel on each of `faces`
    and a letter in the block's colour on the faces `letters` names
    ({'+x': 'A', ...})."""
    box((size, size, size), at, color, yaw=yaw, roll=roll, pitch=pitch)
    pw, t = size * 0.72, 0.06
    off = size / 2 + t / 2 - 0.005
    o = bpy.context.active_object
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    plates = {'+x': (off, 0, 0, t, pw, pw), '-x': (-off, 0, 0, t, pw, pw), '+z': (0, 0, off, pw, pw, t),
              '-z': (0, 0, -off, pw, pw, t), '+y': (0, off, 0, pw, t, pw)}
    for k in faces:
        p = plates[k]
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        f = bpy.context.active_object
        f.scale = (p[3], p[5], p[4])
        f.location = P(p[0], p[1], p[2])
        paint(f, 0xfdf4de)
        f.parent = o
    cell = size * 0.56 / 5
    for k, ch in (letters or {}).items():
        for c0, r0, c1, r1 in GLYPH[ch]:
            face_rect(o, k, size / 2 + t - 0.005 + 0.012, (c0 - 2.5) * cell, (c1 - 1.5) * cell,
                      (r0 - 2.5) * cell, (r1 - 1.5) * cell, color)
    return o

def rollxy(x, y, r):
    """Where (x, y) goes under a `roll` of r (place(): about the along axis;
    a positive roll swings up toward +X)."""
    return x * math.cos(r) + y * math.sin(r), -x * math.sin(r) + y * math.cos(r)

TOY = [0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c]

def toy_car(at, color, yaw=0.0):
    x, y, z = at
    box((1.0, 0.4, 2.0), (x, y + 0.45, z), color, yaw=yaw)
    box((0.9, 0.4, 1.0), (x, y + 0.85, z - 0.1), color, yaw=yaw)
    box((0.85, 0.3, 0.1), (x, y + 0.85, z + 0.42), 0x8ecae6, yaw=yaw)
    for sx in (-1, 1):
        for sz in (-1, 1):
            cyl(0.25, 0.2, (x + sx * 0.5, y + 0.25, z + sz * 0.65), 0x2a2735, segs=10, axis='across', smooth=False)

@piece(1.35)
def slinky():
    # Helix: a rainbow slinky walking down a stack of books. ONE coiled wire,
    # its ends bunched (a stack on the top book, a stack on the floor), the
    # arch between them opened out so the gaps between the coils show: that
    # spring-and-gap is what says slinky. Each colour is a band of coils.
    for k, (c, w, d, x, z, yaw) in enumerate(((0x5a8fd8, 4.0, 3.0, -3.3, 0.0, 0.05), (0xe66a5a, 3.6, 2.8, -3.4, 0.1, -0.08),
                                               (0x6cbf6c, 3.3, 2.6, -3.35, -0.05, 0.12))):
        y, h, t = k * 0.72, 0.72, 0.12
        o = box((w, t, d), (x, y + t / 2, z), c, yaw=yaw)                  # back cover
        box((w, t, d), (x, y + h - t / 2, z), c, yaw=yaw)                  # front cover
        ca, sa = math.cos(yaw), math.sin(yaw)
        box((t, h, d), (x + (w / 2 - t / 2) * ca, y + h / 2, z - (w / 2 - t / 2) * sa), c, yaw=yaw)   # spine, road side
        box((w - 0.2, h - 2 * t, d - 0.24), (x - 0.1 * ca, y + h / 2, z + 0.1 * sa), 0xfdf4de, yaw=yaw)  # the pages
        box((t + 0.02, 0.14, d * 0.5), (x + (w / 2 - t / 2) * ca, y + h / 2, z - (w / 2 - t / 2) * sa), 0xfdf4de, yaw=yaw)
    TOPY = 3 * 0.72
    R, WIRE, TIGHT, OPEN, NEND = 1.0, 0.1, 0.24, 0.7, 6
    a0 = (-3.4, TOPY + WIRE + 0.02)
    b0 = (4.0, WIRE + 0.02)
    a1 = (a0[0], a0[1] + NEND * TIGHT)
    b1 = (b0[0], b0[1] + NEND * TIGHT)
    K = 4.6
    def bez(t):
        p = [a1, (a1[0], a1[1] + K), (b1[0], b1[1] + K), b1]
        m = 1 - t
        w = (m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t)
        return (sum(w[i] * p[i][0] for i in range(4)), sum(w[i] * p[i][1] for i in range(4)))
    # the centre line: up the top stack, over the arch, down the floor stack
    line = [(a0[0], a0[1] + (a1[1] - a0[1]) * i / 40) for i in range(40)]
    line += [bez(i / 400) for i in range(400)]
    line += [(b1[0], b1[1] - (b1[1] - b0[1]) * i / 40) for i in range(41)]
    seg = [math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]) for i in range(len(line) - 1)]
    stack = NEND * TIGHT
    arch = sum(seg) - 2 * stack
    nopen = max(1, round(arch / OPEN))
    def pitch(s):
        return TIGHT if s < stack or s > stack + arch else arch / nopen
    # march the helix round the line, eight points a coil
    pts, s, th, nxt = [], 0.0, 0.0, 0.0
    STEP = 2 * math.pi / 8
    for i in range(len(seg)):
        (x0, y0), (x1, y1) = line[i], line[i + 1]
        tx, ty = (x1 - x0) / (seg[i] or 1), (y1 - y0) / (seg[i] or 1)
        dth = 2 * math.pi * seg[i] / pitch(s)
        while nxt <= th + dth:
            f = (nxt - th) / dth
            cx, cy = x0 + (x1 - x0) * f, y0 + (y1 - y0) * f
            pts.append((cx - ty * R * math.cos(nxt), cy + tx * R * math.cos(nxt), R * math.sin(nxt)))
            nxt += STEP
        th += dth
        s += seg[i]
    RAIN = [0xff5040, 0xff7e44, 0xffc044, 0x6cbf6c, 0x339cf2, 0xa878e8]
    BAND = 3 * 8                                  # three coils a colour
    for k in range(0, len(pts) - 1, BAND):
        tube(pts[k:k + BAND + 1], WIRE, RAIN[(k // BAND) % 6], res=2, bevel_res=0)
        bpy.ops.object.shade_smooth()

@piece(1.4)
def block_castle():
    # Gauntlet: a castle of alphabet blocks built on a cushion fort, the toy
    # siege the track's soldiers and robot lay. The sofa's seat cushions are
    # the castle's ground and its back cushions stand up behind it as the
    # fort's walls; the curtain wall runs along the road with its gate to the
    # road (+X), towers at the four corners flying pennants that flap, side
    # and back walls closing the court, a moat along the front with the
    # drawbridge down across it, and a picture book propped from the cushion
    # to the floor as the ramp up to the gate, a toy car at its foot.
    S, C = 1.4, 1.35                              # a block; the cushions' height
    for k, (x, z) in enumerate((x, z) for x in (-3.1, 1.3) for z in (-4.6, 0.0, 4.6)):
        box((4.3, C, 4.5), (x, C / 2, z), 0xa0a8c9 if k % 2 else 0xa878e8)['round'] = 0.4
    for k, z in enumerate((-4.6, 0.0, 4.6)):      # the back cushions, stood up as the fort's wall
        box((1.2, 5.2, 4.5), (-6.0, 2.6, z), 0xa878e8 if k % 2 else 0xa0a8c9, roll=0.12)['round'] = 0.4
    box((4.2, 4.4, 1.2), (-2.2, 2.2, -7.6), 0xa0a8c9, pitch=-0.1)['round'] = 0.4   # one end cushion
    front = ('+x', '+y')
    for i in range(7):                           # the curtain wall, two courses
        z = (i - 3) * S
        if i != 3:
            block(S, (0, C + S / 2, z), TOY[(i + 1) % 4], faces=front, letters={'+x': ABC[i]})
        block(S, (0, C + S * 1.5, z), TOY[i % 4], faces=front)
        if i % 2 == 0:
            box((S * 0.6, S * 0.5, S * 0.6), (0, C + S * 2.25, z), 0xf2c14e)
    box((0.5, S * 1.05, S * 0.9), (0.2, C + S * 0.52, 0), 0x3a2a22)              # the gateway
    n = 0
    for sz in (-1, 1):
        z = sz * 4 * S
        for x, h in ((0, 3), (-3 * S, 2)):          # front and rear towers
            for j in range(h):
                block(S, (x, C + S / 2 + j * S, z), TOY[(j + sz + 2) % 4], faces=('+x', '+z', '-z', '-x'),
                      letters={'+x': ABC[(j + 4 + sz) % 8]} if x == 0 else None)
            top = C + h * S
            cyl(S * 0.78, S * 0.9, (x, top, z), 0x6cbf6c if x == 0 else 0xe66a5a, r2=0.05, segs=10)
            box((BAR, 1.6, BAR), (x, top + 1.2, z), 0x2a2735)
            with animated('anim_sway:a=x:d=26:p=%.1f#%d' % (1.6 + 0.2 * n, n), (x, top + 1.95, z)):
                box((0.06, 0.55, 1.0), (x, top + 1.7, z + 0.55 * sz), 0xff5040)  # the pennant flaps
            n += 1
        for j in (1, 2):                            # the side walls
            block(S, (-j * S, C + S / 2, z), TOY[(j + 1) % 4], faces=('+y', '+z', '-z'))
    for i in range(7):                              # the back wall, one course
        block(S, (-3 * S, C + S / 2, (i - 3) * S), TOY[(i + 2) % 4], faces=('+y', '-x'))
    # the moat along the front, the drawbridge down across it
    box((1.6, 0.08, 9 * S), (S / 2 + 1.1, C + 0.04, 0), 0x5a8fd8)
    L = 2.4
    box((L, 0.14, S * 0.85), (S / 2 + L / 2, C + 0.16, 0), 0xb08a5a, roll=0.06)
    for s in (-1, 1):
        tube([(S / 2 + 0.05, C + S * 0.95, s * S * 0.38), (S / 2 + L - 0.15, C + 0.3, s * S * 0.38)], 0.03, 0x2a2735, res=2, bevel_res=0)
    # the picture book propped from the cushion's lip to the floor
    a = math.asin((C + 0.1) / 3.6)
    bx = 3.5 + 1.8 * math.cos(a) - 0.2
    box((3.6, 0.26, 2.8), (bx, (C + 0.1) / 2 + 0.05, 0), 0x5a8fd8, roll=-a)
    box((3.5, 0.06, 2.7), (bx, (C + 0.1) / 2 + 0.2, 0), 0xfdf4de, roll=-a)
    toy_car((bx + 0.6, 0, -3.4), 0x6cbf6c, yaw=1.2)
    merge_paint()

@piece(1.5)
def spinning_top():
    # Helix's support: a big wooden spinning top still spinning on its point,
    # wobbling as it goes, its pull string thrown down on the floor beside it
    # with the T handle.
    with animated('anim_sway:a=z:d=7:p=1.6', (0, 0, 0)):          # it wobbles on its point
        cyl(0.06, 0.4, (0, 0, 0), 0x2a2735, r2=0.32, segs=10)
        with animated('anim_spin:w=5', (0, 0, 0)):                 # and spins
            spinning_top_body()
    tube([(-0.9, 0.1, 0.6), (-1.6, 0.1, 1.4), (-2.4, 0.1, 2.0), (-2.1, 0.1, 3.0), (-2.9, 0.1, 3.8)], 0.05, 0xfff6eb, res=3, bevel_res=0)
    box((0.3, 0.3, 1.4), (-3.0, 0.15, 4.0), 0x9a7b55, yaw=-0.9)

def spinning_top_body():
    cyl(0.32, 1.2, (0, 0.4, 0), 0xe66a5a, r2=1.7, segs=16)               # the belly
    cyl(1.76, 0.32, (0, 1.6, 0), 0xffc044, segs=16)                      # the rim
    cyl(1.7, 0.75, (0, 1.92, 0), 0x5a8fd8, r2=0.95, segs=16)             # the shoulder
    cyl(0.95, 0.25, (0, 2.67, 0), 0xffc044, r2=0.55, segs=16)            # the crown
    box((0.34, 1.2, 0.34), (0, 3.4, 0), 0x9a7b55)                        # the handle
    box((0.52, 0.4, 0.52), (0, 4.1, 0), 0x6cbf6c)
    for y in (0.93, 1.35):                        # stripes hugging the belly
        torus(0.32 + 1.38 * (y - 0.4) / 1.2 + 0.03, 0.05, (0, y, 0), 0xfdf4de, segs=16)
    for k in range(4):                            # bands round the shoulder: they show it turning
        a = k * math.pi / 2
        box((0.5, 0.7, 0.14), (math.cos(a) * 1.35, 2.3, math.sin(a) * 1.35), 0xe66a5a, yaw=-a)

@piece(1.5)
def toy_robot():
    # Gauntlet: a boxy wind-up robot marching its beat before the castle, a
    # loop so it never turns back on itself in sight: it rocks from foot to
    # foot as wind-up toys walk, and the big key in its back turns. Visor and
    # eyes, a grille mouth, antenna, claws. Built facing +X at the loop's
    # first point; the renderer turns it along its way.
    RX, RZ, N = 1.6, 4.0, 16
    for k in range(N):
        a = 2 * math.pi * k / N
        marker('path_patrol_%d' % k, (RX * math.cos(a), 0, RZ * math.sin(a)))
    X = RX
    with animated('anim_path:c=patrol:p=14:f=1', (X, 0, 0)):
        for z in (-0.55, 0.55):
            box((1.1, 0.3, 0.9), (X + 0.1, 0.15, z), 0x2a2735)                   # the feet march on
        with animated('anim_waddle:d=9:p=0.9', (X, 0.3, 0)):                      # the rest rocks over them
            for z in (-0.55, 0.55):
                box((0.7, 1.4, 0.7), (X, 1.0, z), 0x9aa1b4)
            box((1.2, 0.45, 1.9), (X, 1.9, 0), 0x868ba1)
            box((1.4, 2.0, 2.0), (X, 3.1, 0), 0x5a8fd8)
            box((0.12, 0.9, 1.2), (X + 0.72, 3.15, 0), 0xd0e8ff)
            for k, c in enumerate((0xff5040, 0x6cbf6c, 0xf2c14e)):
                box((0.12, 0.22, 0.22), (X + 0.8, 3.15, -0.35 + k * 0.35), c)
            for z in (-1.25, 1.25):
                box((0.8, 0.8, 0.5), (X, 3.7, z), 0x9aa1b4)
                box((0.5, 1.6, 0.5), (X, 2.6, z * 1.04), 0x9aa1b4)
                box((0.7, 0.4, 0.35), (X + 0.1, 1.65, z * 1.04), 0xe66a5a)
            box((0.55, 0.4, 0.55), (X, 4.3, 0), 0x868ba1)
            box((1.3, 1.2, 1.5), (X, 5.05, 0), 0x9aa1b4)
            box((0.12, 0.55, 1.2), (X + 0.68, 5.2, 0), 0x2a2735)
            for z in (-0.28, 0.28):
                box((0.12, 0.3, 0.3), (X + 0.74, 5.2, z), 0xf2c14e)
                box((0.3, 0.45, 0.22), (X, 5.05, z * 3.1), 0xe66a5a)
            box((0.12, 0.14, 0.7), (X + 0.68, 4.68, 0), 0xe66a5a)
            box((0.2, 1.0, 0.2), (X, 6.15, 0), 0x2a2735)
            sphere(0.38, (X, 6.85, 0), 0xff5040, subdiv=1)
            # The key is big, a toy's, so its turn reads past the robot's
            # flank: its height swings between the bow's length and width.
            with animated('anim_spin:a=x:w=2.2', (X - 1.0, 3.2, 0)):              # the key winds round
                box((0.7, 0.24, 0.24), (X - 1.05, 3.2, 0), 0x9a7b55)
                box((0.14, 1.8, 0.6), (X - 1.45, 3.2, 0), 0x9a7b55)


# ---- the playroom games ------------------------------------------------------
# Each playroom track is one game laid out on the floor at the room's own
# scale (a car is a toy car, 1.8 long; the pieces are built in world units, so
# their GROW is 1): Skysnake a snakes-and-ladders board, Skyline a desk the
# planes fly from, Helix a marble run, Gauntlet a block castle on a cushion
# fort.

def bar(a, b, w, h, color, roll=0.0):
    """A box from glTF point a to b, `w` across and `h` up (strut's square bar,
    flattened): a ladder rail, a snake's joint."""
    dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
    return box((w, h, math.sqrt(dx * dx + dy * dy + dz * dz)), mid, color,
               yaw=math.atan2(dx, dz), pitch=math.atan2(dy, math.hypot(dx, dz)), roll=roll)

def curve(ctrl, step):
    """Points every `step` along a Catmull-Rom curve through `ctrl` [(x, z)]."""
    dense = []
    n = len(ctrl)
    for i in range(n - 1):
        p0, p1, p2, p3 = ctrl[max(i - 1, 0)], ctrl[i], ctrl[i + 1], ctrl[min(i + 2, n - 1)]
        for k in range(24):
            t = k / 24
            t2, t3 = t * t, t * t * t
            dense.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2
                                      + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in range(2)))
    dense.append(ctrl[-1])
    out, run = [dense[0]], 0.0
    for a, b in zip(dense, dense[1:]):
        run += math.hypot(b[0] - a[0], b[1] - a[1])
        if run >= step:
            out.append(b)
            run = 0.0
    return out

def ladder(a, b, w, color, rung=1.1, t=0.24, rail_h=0.3):
    """A toy ladder from glTF point a to b (the feet of its rails), `w` wide,
    lying or leaning: two rails and the rungs between them."""
    dx, dz = b[0] - a[0], b[2] - a[2]
    hl = math.hypot(dx, dz)
    nx, nz = dz / hl, -dx / hl
    for s in (-1, 1):
        bar((a[0] + nx * s * w / 2, a[1] + rail_h / 2, a[2] + nz * s * w / 2),
            (b[0] + nx * s * w / 2, b[1] + rail_h / 2, b[2] + nz * s * w / 2), t, rail_h, color)
    L = math.dist(a, b)
    n = max(2, int(L / rung))
    for k in range(1, n):
        f = k / n
        c = [a[i] + (b[i] - a[i]) * f for i in range(3)]
        bar((c[0] - nx * w / 2, c[1] + rail_h * 0.6, c[2] - nz * w / 2),
            (c[0] + nx * w / 2, c[1] + rail_h * 0.6, c[2] + nz * w / 2), 0.2, 0.18, color)

PIP = {1: ((0, 0),), 2: ((-1, 1), (1, -1)), 3: ((-1, 1), (0, 0), (1, -1)),
       4: ((-1, 1), (1, 1), (-1, -1), (1, -1)), 5: ((-1, 1), (1, 1), (0, 0), (-1, -1), (1, -1)),
       6: ((-1, 1), (-1, 0), (-1, -1), (1, 1), (1, 0), (1, -1))}

def die(at, s, yaw, faces=(('+x', 5), ('-z', 3), ('+z', 4), ('-x', 2))):
    """A white die, its pips painted on the four sides."""
    box((s, s, s), (at[0], at[1] + s / 2, at[2]), 0xfdf4de, yaw=yaw)
    o = bpy.context.active_object
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    p = s * 0.09
    for face, n in faces:
        for u, v in PIP[n]:
            face_rect(o, face, s / 2 + 0.012, u * s * 0.27 - p, u * s * 0.27 + p, v * s * 0.27 - p, v * s * 0.27 + p, 0x2a2735)

def pawn(at, color, k=1.0):
    x, y, z = at
    cyl(0.75 * k, 0.3 * k, (x, y, z), color, segs=10)
    cyl(0.6 * k, 1.5 * k, (x, y + 0.3 * k, z), color, r2=0.25 * k, segs=10)
    sphere(0.5 * k, (x, y + 2.05 * k, z), color, subdiv=1)

SNAKE = (0x6cbf6c, 0xf2c14e)

@piece(1.0)
def snakes_ladders():
    # Skysnake: a snakes-and-ladders board laid on the floor in the infield,
    # and the game come to life over it: a big jointed wooden snake lies in
    # curves across the board, slides off its edge and rears up beside it,
    # head swaying (the lap's dive is the snake); ladders lie on the board and
    # one runs off it toward the spiral climb (the lap's climb is the ladder).
    # Pawns and dice stand on the squares. Board 24 square, X -12..12.
    B, T = 12.0, 0.3
    box((2 * B + 0.4, T, 2 * B + 0.4), (0, T / 2, 0), 0xb06041)          # the board's edge
    box((2 * B, 0.04, 2 * B), (0, T + 0.02, 0), 0xfdf4de)                 # its printed face
    C = 2 * B / 10
    for i in range(10):
        for j in range(10):
            if (i + j) % 2:
                continue
            x0, z0 = -B + i * C, -B + j * C
            y = T + 0.075                                                     # over the face's 0.06 floor
            quad([(x0, y, z0), (x0 + C, y, z0), (x0 + C, y, z0 + C), (x0, y, z0 + C)], TOY[((i + j) // 2 + j) % 4])
    # ladders on the board, and the long one off its north edge
    ladder((6.5, T + 0.05, -9.0), (8.5, T + 0.05, 3.0), 2.0, 0xb06041)
    ladder((-10.0, T + 0.05, -10.0), (-9.0, T + 0.05, -1.5), 2.0, 0xb06041)
    ladder((4.0, T + 0.05, 9.0), (6.5, 0.0, 22.0), 2.4, 0xb06041, rung=1.3)
    pawn((8.5, T, -5.5), 0xe66a5a)
    pawn((-3.5, T, -9.0), 0x5a8fd8)
    pawn((2.5, T, 9.0), 0xa878e8)
    die((-9.0, T, 9.0), 1.8, 0.4)
    die((-6.2, T, 10.0), 1.8, -0.3, faces=(('+x', 1), ('-z', 6), ('+z', 3), ('-x', 4)))
    # a jointed snake lying across the squares, head down on the board
    toy_snake([(-6.5, 9.0), (-2.0, 6.0), (-6.0, 1.5), (-1.5, -3.0), (3.0, -5.5), (1.5, -9.5)],
              lambda x, z: T, 0.85)
    merge_paint()

def toy_snake(ctrl, base, k, rear=None, tail=None, neck=None):
    """A jointed wooden toy snake lying along the curve through `ctrl` [(x,
    z)], its blocks alternating green and yellow with a gap at every joint,
    tapering to the tail, `k` its size, standing on `base(x, z)`. With `rear`
    (a direction (x, z)), its last joints rise and its head leans out that
    way; otherwise its head lies at the curve's end. `tail` and `neck` name
    those parts' motion (anim_), the tail's last four blocks and the rearing
    neck with its head."""
    joints = curve(ctrl, 1.4 * k)
    N = len(joints)
    def body(i):
        (x0, z0), (x1, z1) = joints[i], joints[i + 1]
        f = min(1.0, 0.55 + 0.45 * i / 8)
        g = 0.13 * k / max(math.hypot(x1 - x0, z1 - z0), 0.01)
        y = max(base(x0, z0), base(x1, z1)) + 0.5 * f * k
        bar((x0 + (x1 - x0) * g, y, z0 + (z1 - z0) * g), (x1 - (x1 - x0) * g, y, z1 - (z1 - z0) * g),
            1.25 * f * k, 1.0 * f * k, SNAKE[i % 2])
    if tail:
        with animated(tail, (joints[4][0], base(*joints[4]), joints[4][1])):
            for i in range(4):
                body(i)
    for i in range(0 if not tail else 4, N - 1):
        body(i)
    def head(hx, hy, hz, d, pitch):
        yaw = math.atan2(d[0], d[1])
        box((1.5 * k, 1.05 * k, 2.4 * k), (hx, hy, hz), 0x6cbf6c, yaw=yaw, pitch=pitch)
        box((1.2 * k, 0.3 * k, 2.0 * k), (hx + d[0] * 0.15 * k, hy - 0.57 * k, hz + d[1] * 0.15 * k), 0xf2c14e,
            yaw=yaw, pitch=pitch)
        sx, sz = d[1], -d[0]
        for sd in (-1, 1):
            ex, ez = hx + d[0] * 0.45 * k + sx * sd * 0.62 * k, hz + d[1] * 0.45 * k + sz * sd * 0.62 * k
            box((0.42 * k, 0.42 * k, 0.42 * k), (ex, hy + 0.45 * k, ez), 0xfdf4de, yaw=yaw)
            box((0.22 * k, 0.26 * k, 0.26 * k), (ex + sx * sd * 0.14 * k + d[0] * 0.1 * k, hy + 0.47 * k,
                                                 ez + sz * sd * 0.14 * k + d[1] * 0.1 * k), 0x2a2735, yaw=yaw)
        tx, tz, ty = hx + d[0] * 1.2 * k, hz + d[1] * 1.2 * k, hy - 0.4 * k
        bar((tx, ty, tz), (tx + d[0] * 0.8 * k, ty - 0.1 * k, tz + d[1] * 0.8 * k), 0.14 * k, 0.08 * k, 0xff5040)
        for sd in (-1, 1):
            fx, fz = tx + d[0] * 0.8 * k, tz + d[1] * 0.8 * k
            bar((fx, ty - 0.1 * k, fz), (fx + d[0] * 0.35 * k + sx * sd * 0.2 * k, ty - 0.13 * k, fz + d[1] * 0.35 * k + sz * sd * 0.2 * k),
                0.12 * k, 0.08 * k, 0xff5040)
    (px, pz), (ex, ez) = joints[-2], joints[-1]
    if not rear:
        l = math.hypot(ex - px, ez - pz) or 1.0
        d = ((ex - px) / l, (ez - pz) / l)
        head(ex + d[0] * 1.0 * k, base(ex, ez) + 0.55 * k, ez + d[1] * 1.0 * k, d, 0.0)
        return
    d, nx, nz, y0 = rear, ex, ez, base(ex, ez)
    NECK = ((0, 0.55), (0.55, 1.5), (0.85, 2.5), (0.95, 3.5), (1.1, 4.4), (1.55, 5.2), (2.25, 5.7))
    with animated(neck, (nx, y0, nz)):
        for i in range(len(NECK) - 1):
            (h0, a0), (h1, a1) = NECK[i], NECK[i + 1]
            bar((nx + d[0] * h0 * k, y0 + a0 * k, nz + d[1] * h0 * k), (nx + d[0] * h1 * k, y0 + a1 * k, nz + d[1] * h1 * k),
                1.15 * k, 1.05 * k, SNAKE[(N + i) % 2])
        head(nx + d[0] * 3.1 * k, y0 + 5.75 * k, nz + d[1] * 3.1 * k, d, -0.12)

@piece(1.0)
def jointed_snake():
    # Skysnake's hero: the board's snake come alive and grown huge, lying in
    # curves on the floor below the lap's dive (the dive is the snake). It
    # rears up at its -Z end and sways its head out over -X toward the racers
    # coming down the dive, and its tail swishes. Its body runs along Z.
    toy_snake([(0.0, 11.0), (2.6, 7.0), (-2.6, 3.0), (2.0, -2.0), (-1.0, -6.0), (0.0, -9.0)],
              lambda x, z: 0.0, 1.55, rear=(-1.0, 0.0),
              tail='anim_sway:a=y:d=30:p=2.3#tail', neck='anim_sway:a=y:d=24:p=3.3#neck')

@piece(1.0)
def game_box():
    # Skysnake: the game's box stood on its edge by the spiral climb, a big
    # ladder leaning on it (the lap climbs here), the lid's green snake and
    # its yellow title band to the road (+X), the board's spare die beside it.
    W, H, D = 14.0, 9.0, 1.6
    box((D, H, W), (0, H / 2, 0), 0x5a8fd8)
    plate_x(D / 2 + 0.01, H - 2.6, H - 0.8, -W / 2 + 1.0, W / 2 - 1.0, 0xf2c14e)       # the title band
    tube([(D / 2 + 0.15, 1.2, -5.5), (D / 2 + 0.15, 3.2, -2.5), (D / 2 + 0.15, 1.8, 0.5),
          (D / 2 + 0.15, 4.4, 3.0), (D / 2 + 0.15, 5.4, 5.2)], 0.3, 0x6cbf6c, res=3, bevel_res=0)
    box((0.3, 0.8, 1.1), (D / 2 + 0.15, 5.6, 5.6), 0x6cbf6c)                       # its head
    for z in (-1.2, 2.5):                                                         # the drawn ladders
        for s in (-1, 1):
            plate_x(D / 2 + 0.02, 1.0, 5.2, z + s * 0.7 - 0.12, z + s * 0.7 + 0.12, 0xb06041)
        for y in (1.8, 2.8, 3.8, 4.8):
            plate_x(D / 2 + 0.02, y - 0.1, y + 0.1, z - 0.7, z + 0.7, 0xb06041)
    ladder((6.4, 0.0, -3.0), (D / 2 + 0.3, H - 0.6, -3.0), 2.4, 0xff7e44, rung=1.2, rail_h=0.3)
    die((4.5, 0, 4.5), 2.2, 0.5)
    merge_paint()

def biplane(at, k=1.0, prop=None):
    """A toy biplane nose to +Z, wheels under it at `at`; `prop` names the
    propeller's spin (anim_) when it turns."""
    x, y, z = at
    def P_(dx, dy, dz):
        return (x + dx * k, y + dy * k, z + dz * k)
    box((0.9 * k, 0.9 * k, 3.2 * k), P_(0, 1.0, 0), 0xff5040)
    cyl(0.45 * k, 0.6 * k, P_(0, 1.0, 1.6), 0xff5040, r2=0.3 * k, segs=10, axis='along')
    for dy in (0.7, 1.7):
        box((4.2 * k, 0.08 * k, 0.9 * k), P_(0, dy, 0.6), 0x5a8fd8)
    for sx in (-1.5, 1.5):
        for sz in (0.25, 0.95):
            box((0.06 * k, 1.0 * k, 0.06 * k), P_(sx, 1.2, sz), 0x9a7b55)
    box((0.08 * k, 0.9 * k, 0.7 * k), P_(0, 1.75, -1.5), 0xff5040)
    box((1.6 * k, 0.08 * k, 0.7 * k), P_(0, 1.3, -1.5), 0x5a8fd8)
    box((0.5 * k, 0.4 * k, 0.5 * k), P_(0, 1.55, 0.2), 0x8ecae6)
    for s in (-1, 1):
        cyl(0.22 * k, 0.14 * k, P_(s * 0.5, 0.25, 0.8), 0x2a2735, segs=10, axis='across', smooth=False)
        box((0.06 * k, 0.5 * k, 0.06 * k), P_(s * 0.5, 0.45, 0.8), 0x9aa1b4)
    def blades():
        cyl(0.1 * k, 0.3 * k, P_(0, 1.0, 2.2), 0x2a2735, segs=8, axis='along', smooth=False)
        for j in range(3):
            box((0.12 * k, 1.2 * k, 0.06 * k), P_(0, 1.0, 2.5), 0x9a7b55, roll=j * math.pi / 3)
    if prop:
        with animated(prop, P_(0, 1.0, 2.5)):
            blades()
    else:
        blades()

def rocket(at, k=1.0):
    """A toy rocket nose-up on its pad, fins to the pad."""
    x, y, z = at
    cyl(1.6 * k, 0.3 * k, (x, y, z), 0x9aa1b4, segs=16)
    cyl(0.45 * k, 0.5 * k, (x, y + 0.3 * k, z), 0x555b66, r2=0.65 * k, segs=12)
    cyl(0.85 * k, 0.45 * k, (x, y + 0.8 * k, z), 0xff5040, segs=14)
    cyl(0.8 * k, 4.0 * k, (x, y + 0.8 * k, z), 0xfff6eb, segs=14)
    cyl(0.83 * k, 0.3 * k, (x, y + 4.5 * k, z), 0xff5040, segs=14)
    cyl(0.8 * k, 1.6 * k, (x, y + 4.8 * k, z), 0xff5040, r2=0.05, segs=14)
    for i in range(3):
        a = i * 2 * math.pi / 3 + 0.5
        box((0.16 * k, 1.8 * k, 1.1 * k), (x + math.cos(a) * 1.15 * k, y + 1.2 * k, z + math.sin(a) * 1.15 * k), 0xff5040,
            yaw=-a + math.pi / 2)
    cyl(0.45 * k, 0.1 * k, (x + 0.74 * k, y + 3.2 * k, z), 0x9aa1b4, segs=12, axis='across', smooth=False)   # the porthole
    cyl(0.34 * k, 0.1 * k, (x + 0.8 * k, y + 3.2 * k, z), 0x339cf2, segs=12, axis='across', smooth=False)

@piece(1.0)
def flight_desk():
    # Skyline (variant A, "flight from the desk"): a child's desk in the
    # infield under the high skyway, the airfield of a game of flying. On its
    # top: a paper runway drawn in pencil, a toy biplane on a tether circling
    # its pole over the runway (propeller turning), a rocket on its pad,
    # steaming, and a globe that turns. Open under the top, so the infield
    # reads through its legs. Its long side (Z) runs along the skyway.
    TOP, W, L, TH = 6.5, 14.0, 24.0, 0.8
    box((W, TH, L), (0, TOP - TH / 2, 0), 0xa8744a)                                  # the top
    for sx in (-1, 1):                                                               # legs, the pedestal end
        box((0.9, TOP - TH, 0.9), (sx * (W / 2 - 0.7), (TOP - TH) / 2, L / 2 - 0.7), 0x8a5a3a)
    box((W - 0.6, TOP - TH, 6.0), (0, (TOP - TH) / 2, -L / 2 + 3.2), 0x8a5a3a)        # the drawer pedestal
    for k in range(3):
        y = 0.9 + k * 1.75
        box((0.12, 1.4, 4.8), (W / 2 - 0.25, y + 0.7, -L / 2 + 3.2), 0xb88454)          # drawer fronts to the road side
        box((0.25, 0.3, 0.9), (W / 2 - 0.12, y + 0.7, -L / 2 + 3.2), 0xf2c14e)          # knobs
    box((W - 1.4, 0.5, 0.3), (0, TOP - TH - 0.6, L / 2 - 0.7), 0x8a5a3a)               # a rail between the far legs
    # the paper runway under the circling plane
    box((6.8, 0.06, 13.0), (0.5, TOP + 0.03, 4.8), 0xfdf4de, yaw=0.08)
    box((1.6, 0.03, 12.0), (0.5, TOP + 0.07, 4.8), 0x868ba1, yaw=0.08)
    for k in range(6):
        z = -0.4 + k * 2.0
        box((0.22, 0.03, 0.9), (0.5 + 0.08 * (z - 4.8), TOP + 0.09, z), 0xfdf4de, yaw=0.08)
    # the tether pole and the plane flying round it
    PX, PZ, PH = 0.5, 4.8, 4.2
    cyl(1.0, 0.3, (PX, TOP + 0.06, PZ), 0x5a8fd8, segs=12)
    cyl(0.18, PH, (PX, TOP + 0.36, PZ), 0x9aa1b4, segs=8)
    R = 4.0
    with animated('anim_spin:w=-0.9', (PX, TOP + PH + 0.36, PZ)):                # it flies nose first
        cyl(0.4, 0.4, (PX, TOP + PH + 0.2, PZ), 0xf2c14e, segs=10)
        bar((PX, TOP + PH + 0.4, PZ), (PX + R, TOP + PH - 0.75, PZ - 0.6), 0.12, 0.12, 0x2a2735)
        biplane((PX + R + 0.4, TOP + PH - 1.75, PZ - 0.6), k=1.0, prop='anim_spin:a=z:w=14')
    # the rocket on its pad, steaming before its launch
    rocket((-3.4, TOP, -7.5), k=1.15)
    marker('anim_smoke', (-3.4, TOP + 0.5, -7.5))
    # the globe on its stand, turning
    GX, GZ, GR = 3.8, -8.2, 1.5
    cyl(0.9, 0.25, (GX, TOP, GZ), 0x8a5a3a, segs=10)
    cyl(0.14, 1.2, (GX, TOP + 0.25, GZ), 0x9aa1b4, segs=6)
    torus(GR + 0.25, 0.08, (GX, TOP + 1.45 + GR, GZ), 0x9aa1b4, segs=14, axis='across')
    with animated('anim_spin:w=0.7', (GX, TOP + 1.45 + GR, GZ)):
        sphere(GR, (GX, TOP + 1.45 + GR, GZ), 0x339cf2, subdiv=2, flat=False)
        for a, h, s in ((0.3, 0.4, 0.8), (2.2, -0.2, 0.9), (4.1, 0.6, 0.6)):
            sphere(0.6 * s, (GX + math.cos(a) * GR * 0.93, TOP + 1.45 + GR + h * GR, GZ + math.sin(a) * GR * 0.93),
                   0x6cbf6c, subdiv=1, scale=(1.3, 0.7, 1.1), yaw=a)
    # a pencil pot
    cyl(0.75, 1.5, (4.6, TOP, -2.8), 0xe66a5a, segs=10)
    for k, (dx, dz, c) in enumerate(((-0.25, 0.1, 0xf2c14e), (0.25, -0.2, 0x5a8fd8), (0.05, 0.3, 0x6cbf6c))):
        o = cyl(0.15, 2.6, (4.6 + dx, TOP + 0.4, -2.8 + dz), c, segs=6)
        tilted(o, 0.12 * (k - 1), 0.1)

def helix_pts(cx, cz, R, y0, y1, a0, turns, per=16):
    n = int(turns * per)
    return [(cx + R * math.cos(a0 + 2 * math.pi * turns * i / n), y0 + (y1 - y0) * i / n,
             cz + R * math.sin(a0 + 2 * math.pi * turns * i / n)) for i in range(n + 1)]

@piece(1.0)
def marble_run():
    # Helix: a marble run that is the lap in small. Marbles climb a screw
    # round one tower, roll along a high chute to the second, corkscrew down
    # it and run home along the floor: the track's two spirals, its skyway and
    # its run home, so the loop is closed in sight and never needs hiding.
    # Towers on the piece's Z axis, A (up) at +Z, B (down) at -Z.
    ZA, ZB, R, TURNS = 15.0, -15.0, 3.4, 2.5
    MR = 0.9                                     # a marble's radius: a big glass one
    LOW, HIGH_A, HIGH_B = 0.97, 12.0, 11.0       # marble centre heights: the low run lies on the floor
    up = helix_pts(0, ZA, R, LOW, HIGH_A, 0.0, TURNS)
    down = helix_pts(0, ZB, R, HIGH_B, LOW, math.pi, TURNS)
    loop = up + down                             # up ends at angle pi (-X side), down ends at 0 (+X)
    # the towers: stacked toy cylinders, a cap on each
    for zc, h in ((ZA, HIGH_A + 1.5), (ZB, HIGH_B + 1.5)):
        cyl(2.2, 0.4, (0, 0, zc), 0x9aa1b4, segs=12)
        n = 5
        for k in range(n):
            cyl(1.25, h / n, (0, 0.4 + k * h / n, zc), TOY[k % 4], segs=10)
        cyl(1.5, 0.5, (0, 0.4 + h, zc), 0xfdf4de, segs=10)
    # the chute: a U channel under the marbles, swept along their line; its
    # inside and outside are separate faces so each keeps its own light
    def chute(pts, color, half=1.1, wall=0.8):
        n = len(pts)
        verts = []
        for i, p in enumerate(pts):
            a, b = pts[min(i + 1, n - 1)], pts[max(i - 1, 0)]
            tx, tz = a[0] - b[0], a[2] - b[2]
            l = math.hypot(tx, tz) or 1.0
            ox, oz = -tz / l * half, tx / l * half
            y = p[1] - MR - 0.05
            verts += [(p[0] + ox, y + wall, p[2] + oz), (p[0] + ox, y, p[2] + oz),
                      (p[0] - ox, y, p[2] - oz), (p[0] - ox, y + wall, p[2] - oz)]
        front = [(4 * i + k, 4 * (i + 1) + k, 4 * (i + 1) + k + 1, 4 * i + k + 1) for i in range(n - 1) for k in range(3)]
        m = len(verts)
        me = bpy.data.meshes.new('chute')
        me.from_pydata([tuple(P(*v)) for v in verts + verts], [],
                       front + [tuple(m + v for v in reversed(f)) for f in front])
        for f in me.polygons:
            f.use_smooth = True
        me.update()
        o = bpy.data.objects.new('chute', me)
        bpy.context.scene.collection.objects.link(o)
        return paint(o, color)
    chute(up, 0xe66a5a)
    chute(down, 0x5a8fd8)
    chute([up[-1], down[0]], 0xf2c14e)            # the high run from A's top to B's
    chute([down[-1], up[0]], 0xf2c14e)            # and the low run home along the floor
    # spokes from each tower to its screw, and legs under the high chute
    for zc, pts in ((ZA, up), (ZB, down)):
        for i in range(4, len(pts) - 1, 8):
            p = pts[i]
            dx, dz = p[0], p[2] - zc
            l = math.hypot(dx, dz)
            bar((dx / l * 1.2, p[1] - MR - 0.1, zc + dz / l * 1.2), (p[0] - dx / l * 0.7, p[1] - MR - 0.1, p[2] - dz / l * 0.7),
                0.3, 0.3, 0x9aa1b4)
    for f in (0.33, 0.66):
        x = up[-1][0]
        z = up[-1][2] + (down[0][2] - up[-1][2]) * f
        y = HIGH_A + (HIGH_B - HIGH_A) * f - MR - 0.05
        box((0.4, y, 0.4), (x, y / 2, z), 0x9aa1b4)
        box((1.6, 0.3, 1.6), (x, 0.15, z), 0x9aa1b4)
    # the path the marbles ride, and the marbles spread round it
    for k, p in enumerate(loop):
        marker('path_marbles_%d' % k, p)
    total = 0.0
    seglen = []
    for i in range(len(loop)):
        a, b = loop[i], loop[(i + 1) % len(loop)]
        seglen.append(math.dist(a, b))
    total = sum(seglen)
    COLS = (0x7db8e8, 0xe66a5a, 0x6cbf6c, 0xf2c14e, 0xa878e8, 0x7db8e8, 0xff7e44)
    NM = len(COLS)
    for m in range(NM):
        s = total * m / NM
        i = 0
        while s > seglen[i]:
            s -= seglen[i]
            i += 1
        a, b = loop[i], loop[(i + 1) % len(loop)]
        f = s / seglen[i]
        at = tuple(a[j] + (b[j] - a[j]) * f for j in range(3))
        with animated('anim_path:c=marbles:p=24:o=%.4f:f=0#%d' % (m / NM, m), at):
            sphere(MR, at, COLS[m], subdiv=2, flat=False)

# ---- playroom companions ----

@piece(1.4)
def marbles():
    # Skysnake: big glass marbles rolled out of a cloth pouch lying on its
    # side, mouth open toward them. Marbles are round (smooth), each with a
    # swirl band of a second colour round it, so they read as marbles and not
    # as gems.
    for k, (x, z, r, c, s, a) in enumerate(((0.4, 0.6, 0.7, 0x7db8e8, 0xfdf4de, 0.5), (1.7, 1.5, 0.55, 0xe66a5a, 0xffc044, -0.7),
                                            (0.5, 2.4, 0.6, 0x6cbf6c, 0xfdf4de, 1.1), (-0.9, 1.6, 0.5, 0xffc044, 0xe66a5a, 0.2),
                                            (2.6, 2.7, 0.45, 0x7db8e8, 0xffc044, -0.3), (1.5, -0.3, 0.5, 0xa878e8, 0xfdf4de, 0.9))):
        sphere(r, (x, r, z), c, subdiv=2, flat=False)
        o = sphere(r * 1.03, (x, r, z), s, subdiv=2, flat=False, scale=(1.0, 1.0, 0.3), yaw=a)
        o.rotation_euler.x = 0.4 + 0.3 * k
    a = 0.69                                      # the pouch points at the spill
    sphere(1.0, (-1.4, 0.75, -1.6), 0xa878e8, subdiv=2, flat=False, scale=(1.0, 0.75, 1.15), yaw=a)
    nx, nz = -1.4 + 1.0 * math.sin(a), -1.6 + 1.0 * math.cos(a)
    cyl(0.32, 0.5, (nx, 0.75, nz), 0xa878e8, r2=0.5, segs=10, axis='along', yaw=a)        # the neck, flared
    o = torus(0.36, 0.05, (nx + 0.12 * math.sin(a), 0.75, nz + 0.12 * math.cos(a)), 0xffc044, segs=10, axis='along', yaw=a)
    bpy.ops.object.shade_smooth()

@piece(1.4)
def cardboard_box():
    # Skyline: an open cardboard box, its four flaps folded back on their
    # hinges at the rim, a toy car and a block inside, tape across a side.
    W, H, L = 2.6, 1.8, 1.1
    CB = 0xf2bf99
    for s2 in (-1, 1):
        box((W, H, 0.1), (0, H / 2, s2 * W / 2), CB)
        box((0.1, H, W), (s2 * W / 2, H / 2, 0), CB)
    box((W, 0.1, W), (0, 0.05, 0), CB)
    up, down = 0.55, -0.3                         # the Z flaps lifted, the X flaps drooped
    for s2 in (-1, 1):
        box((W, 0.08, L), (0, H + L / 2 * math.sin(up), s2 * (W / 2 + L / 2 * math.cos(up))), CB, pitch=s2 * up)
        x, y = s2 * (W / 2 + L / 2 * math.cos(down)), H + L / 2 * math.sin(down)
        box((L, 0.08, W - 0.1), (x, y, 0), CB, roll=-s2 * down)
    box((0.12, 0.9, 0.5), (W / 2 + 0.02, H / 2, 0), 0xb06041)          # tape down the road side
    for k in range(4):                            # blocks heaped in the bottom
        block(1.0, ((k % 2 - 0.5) * 1.15, 0.6, (k // 2 - 0.5) * 1.15), TOY[k], yaw=0.2 * k, faces=('+y',))
    toy_car((0.2, 1.1, -0.3), 0x5a8fd8, yaw=0.6)
    block(0.9, (-0.6, 1.55, 0.6), TOY[2], yaw=0.4, letters={'+x': 'A'})
    merge_paint()

def soldier(at, color):
    # a wooden soldier facing +X: trousers, coat with belt and arms, face,
    # busby, his rifle held at his side
    x, y, z = at
    box((0.58, 1.0, 0.48), (x, y + 0.5, z), 0x2a2735)
    box((0.7, 1.0, 0.56), (x, y + 1.5, z), color)
    box((0.72, 0.14, 0.58), (x, y + 1.15, z), 0xfdf4de)
    plate_x(x + 0.362, y + 1.25, y + 1.95, z - 0.05, z + 0.05, 0xffc044)
    for s in (-1, 1):
        box((0.3, 0.85, 0.24), (x, y + 1.55, z + s * 0.4), color)
        box((0.26, 0.24, 0.22), (x, y + 1.02, z + s * 0.4), 0xf2bf99)
    box((0.5, 0.5, 0.5), (x, y + 2.25, z), 0xf2bf99)
    for s in (-1, 1):
        plate_x(x + 0.262, y + 2.27, y + 2.37, z + s * 0.12 - 0.05, z + s * 0.12 + 0.05, 0x2a2735)
    plate_x(x + 0.262, y + 2.08, y + 2.16, z - 0.11, z + 0.11, 0xe66a5a)
    box((0.58, 0.75, 0.58), (x, y + 2.87, z), 0x2a2735)
    plate_x(x + 0.302, y + 2.66, y + 2.84, z - 0.09, z + 0.09, 0xffc044)
    box((0.14, 1.5, 0.14), (x + 0.06, y + 1.75, z + 0.59), 0x9aa1b4)       # barrel
    box((0.2, 0.6, 0.2), (x + 0.06, y + 0.85, z + 0.59), 0x9a7b55)         # stock, at the hand

@piece(1.4)
def toy_soldiers():
    # Gauntlet: three wooden soldiers in a row on their stand, guarding the road.
    box((1.2, 0.2, 4.6), (0, 0.1, 0), 0x6cbf6c)
    for k in range(3):
        soldier((0, 0.2, -1.5 + k * 1.5), 0xff5040 if k != 1 else 0x5a8fd8)
    merge_paint()

# ---- build + export ----------------------------------------------------------------

def chamfer():
    """The cars' chamfer: every edge of a block or a bar cut at 45 degrees, one
    segment, a fifth of its thinnest side and never past CHAMFER. Hardened
    normals keep the faces flat and run the cut smooth between them, so a
    corner keeps one normal and the chamfer adds triangles, not vertices (a
    flat-shaded cut would cost a box four times its vertices). Not cylinders:
    there it triples the count and barely shows. A block marked 'round' gets
    a round-over instead: three segments, that wide (a third of its thinnest
    side at most)."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    for o in bpy.context.scene.objects:
        if o.type != 'MESH' or not o.get('chamfer'):
            continue
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        b = o.modifiers.new('chamfer', 'BEVEL')
        r = o.get('round')
        b.width = min(r, 0.33 * min(o.dimensions)) if r else min(CHAMFER, 0.2 * min(o.dimensions))
        b.segments = 3 if r else 1
        b.limit_method = 'ANGLE'
        b.angle_limit = math.radians(40)
        b.use_clamp_overlap = True
        b.harden_normals = True
        for p in o.data.polygons:
            p.use_smooth = True

CHAMFER = 0.05   # the car's 0.02 at its 0.9 length, at this scale and a little over

def join_groups():
    """Each group() becomes one object named after it, its parts' bevels
    applied first (a join keeps only the active object's modifiers)."""
    groups = {}
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and o.get('group'):
            groups.setdefault(o['group'], []).append(o)
    for name, objs in groups.items():
        for o in objs:
            bpy.ops.object.select_all(action='DESELECT')
            o.select_set(True)
            bpy.context.view_layer.objects.active = o
            for m in list(o.modifiers):
                bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        objs[0].name = name
        objs[0].data.name = name

def finalize_and_export(name):
    k = GROW.get(name, 1.0)
    shade()
    chamfer()
    join_groups()
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and not o.data.uv_layers:
            o.data.uv_layers.new(name='UVMap')
        if o.parent is None and k != 1.0:
            o.location = o.location * k
            o.scale = o.scale * k
    join_anims(k)
    bpy.ops.object.select_all(action='SELECT')
    out = os.path.join(OUT_DIR, 'set-%s.glb' % name)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=True,
                              export_image_format='NONE', export_materials='EXPORT',
                              export_animations=False, export_skins=False, export_morph=False,
                              export_cameras=False, export_lights=False, export_extras=False,
                              export_vertex_color='NONE')
    tris = sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type == 'MESH')
    print('PIECE %s %s faces=%d grow=%.2f' % (name, out, tris, k))

os.makedirs(OUT_DIR, exist_ok=True)
for name, fn in PIECES.items():
    if ONLY and name not in ONLY:
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    fn()
    finalize_and_export(name)
