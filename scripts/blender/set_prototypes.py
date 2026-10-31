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

def hut(w, h, d, at, wall, roof, yaw=0.0, t=1.0):
    """A little gabled hut, door on +X, dressed as a car is: a grey plinth, a
    dark door and windows standing proud in white frames, a chunky roof under
    a grey ridge. `t` scales the dressing (plinth, frames, roof) for a hut at
    real size beside a car, a fifth of the toy-scale one's."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def part(dx, dy, dz, size, color, pitch=0.0):   # offset in the hut's own frame
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw, pitch=pitch)
    part(0, h / 2, 0, (w, h, d), wall)
    part(0, 0.15 * t, 0, (w + 0.2 * t, 0.3 * t, d + 0.2 * t), 'grey')
    dw = min(d * 0.4, 0.9 * t)
    part(w / 2 + 0.04 * t, h * 0.36, 0, (0.1 * t, h * 0.72 + 0.12 * t, dw + 0.24 * t), 'white')
    part(w / 2 + 0.1 * t, h * 0.33, 0, (0.1 * t, h * 0.66, dw), 'slate')
    for k in (-1, 1):
        part(0, h * 0.58, k * (d / 2 + 0.04 * t), (w * 0.42 + 0.2 * t, h * 0.3 + 0.2 * t, 0.1 * t), 'white')
        part(0, h * 0.58, k * (d / 2 + 0.1 * t), (w * 0.42, h * 0.3, 0.1 * t), 'slate')
        part(0, h + 0.3 * t, k * (d + 0.5 * t) / 4, (w + 0.5 * t, 0.24 * t, (d + 0.5 * t) * 0.55), roof, pitch=-k * 0.6)
    part(0, h + 0.3 * t + 0.155 * (d + 0.5 * t) + 0.08 * t, 0, (w + 0.6 * t, 0.22 * t, 0.34 * t), 'grey')

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

def dead_tree(at, h=6.0, color=0x8a6a46):
    x, y, z = at
    cyl(0.45, h, (x, y, z), color, r2=0.2, segs=7, smooth=False)
    for i, (a, t, l) in enumerate(((0.3, 0.55, 2.8), (2.4, 0.5, 2.4), (4.2, 0.65, 2.0), (1.4, 0.95, 1.6))):
        o = cyl(0.16, l, (x, y + h * (0.55 + 0.12 * i), z), color, r2=0.04, segs=5, smooth=False)
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

# Every beach piece stands at the size a car makes it (a car is 0.9 long, so
# 1 u is about 4.5 m): a person is half a car long, an umbrella a little over
# a car's height, a lifeguard tower two. Only what is big in life is big here:
# the reef and its pool, a ship, the headland. These builders author in world
# units and grow 1; the reef alone keeps its toy-scale build grown.

# ---- the beach's people, birds and gear ----

def figure(at, yaw=0.0, shirt=0xff5040, legs=0x339cf2, skin=0xf2bf99, hair=0x7a5a3a, pose='stand'):
    """A person half a car long, facing +X turned by `yaw`, in blocks as the
    cars' drivers are: `stand`, `sit` (on the sand, legs out to +X), `crouch`
    or `lie` (on the back, head to -X)."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def b(size, dx, dy, dz, color):
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw)
    if pose == 'stand':
        b((0.08, 0.2, 0.16), 0, 0.1, 0, legs)
        b((0.1, 0.17, 0.24), 0, 0.285, 0, shirt)                          # shoulders and arms
        b((0.11, 0.11, 0.11), 0, 0.43, 0, skin)
        b((0.12, 0.04, 0.12), -0.01, 0.5, 0, hair)
    elif pose in ('sit', 'crouch'):
        if pose == 'sit':
            b((0.22, 0.07, 0.15), 0.08, 0.035, 0, legs)                    # legs out
        else:
            b((0.12, 0.14, 0.15), 0.05, 0.07, 0, legs)                     # knees up
        b((0.1, 0.17, 0.2), -0.05, 0.155, 0, shirt)
        b((0.11, 0.11, 0.11), -0.03, 0.3, 0, skin)
        b((0.12, 0.04, 0.12), -0.04, 0.37, 0, hair)
    else:
        b((0.22, 0.06, 0.15), 0.17, 0.03, 0, legs)
        b((0.17, 0.08, 0.2), -0.03, 0.04, 0, shirt)
        b((0.1, 0.09, 0.1), -0.17, 0.045, 0, skin)

def gull(at, yaw=0.0, life=None):
    """A gull standing on its feet, facing +X turned by `yaw`, 0.16 tall
    (twice a gull beside a car, so it reads at all): white body and head, a
    grey back, a yellow bill. `life` names its motion (set_motion.h),
    pivoting between its feet: watching the cars, hopping off as one passes."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def b(size, dx, dy, dz, color):
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw)
    def build():
        b((0.06, 0.06, 0.06), 0, 0.03, 0, 0xff7e44)                          # legs
        b((0.16, 0.07, 0.09), -0.01, 0.09, 0, 0xf8f8fb)                      # body
        b((0.13, 0.03, 0.1), -0.04, 0.13, 0, 0x9aa1b4)                       # wings
        b((0.07, 0.07, 0.065), 0.07, 0.145, 0, 0xf8f8fb)                     # head
        b((0.06, 0.06, 0.06), 0.12, 0.14, 0, 0xffc044)                       # bill
    if life:
        with animated(life, (x, y, z), yaw):
            build()
    else:
        build()

def boat(at, yaw, hull, trim=0xfff6eb, L=0.95):
    """A small open boat pulled up the sand, bow to +Z turned by `yaw`: a hull
    a car long, its gunwale and thwart, the bow drawn to a point."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def b(size, dx, dy, dz, color, turn=0.0):
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw + turn)
    b((0.36, 0.14, L * 0.8), 0, 0.07, -L * 0.08, hull)
    b((0.25, 0.14, 0.25), 0, 0.07, L * 0.32, hull, turn=math.pi / 4)        # the bow
    b((0.4, 0.05, L * 0.82), 0, 0.165, -L * 0.08, trim)
    b((0.3, 0.06, 0.08), 0, 0.17, 0.0, 0x9a7b55)                            # the thwart

def creel(at, yaw=0.0):
    """A crab pot a fifth of a car long: a plank base, its net drawn over."""
    x, y, z = at
    box((0.26, 0.06, 0.36), (x, y + 0.03, z), 0x9a7b55, yaw=yaw)
    box((0.22, 0.16, 0.32), (x, y + 0.14, z), 'sky', yaw=yaw)

def umbrella(at, r, h, colors, gores=8):
    """A beach umbrella: a pole and a canopy of gores in alternating colours,
    peaked over the pole and falling to its rim."""
    x, y, z = at
    beam((x, y, z), (x, y + h + 0.06, z), 0.06, 0xfff6eb)
    top = (x, y + h + 0.05, z)
    for i in range(gores):
        a0, a1 = i / gores * 2 * math.pi, (i + 1) / gores * 2 * math.pi
        rim0 = (x + math.cos(a0) * r, y + h - 0.1, z + math.sin(a0) * r)
        rim1 = (x + math.cos(a1) * r, y + h - 0.1, z + math.sin(a1) * r)
        poly([top, rim0, rim1], [(0, 1, 2)], colors[i % len(colors)])

def palm(at, h=2.4, lean=0.3, yaw=0.0):
    """A palm in the kit's manner, as tall as the beach's own (1.8 to 3): a
    leaning trunk in three tapering lengths, a crown of drooping fronds, two
    coconuts."""
    x, y, z = at
    k = h / 4.2
    dx, dz = math.cos(yaw), math.sin(yaw)
    pts = [(x + dx * lean * h * t * t, y + h * t, z + dz * lean * h * t * t) for t in (0, 0.36, 0.7, 1.0)]
    for i in range(3):
        rod(pts[i], pts[i + 1], (0.3 - 0.06 * i) * k, 0x9a7b55, r2=(0.26 - 0.06 * i) * k, segs=6)
    tx, ty, tz = pts[-1]
    for i in range(6):                                  # each frond one blade, drooping
        a = yaw + i * math.pi / 3 + 0.3
        ca, sa = math.cos(a), math.sin(a)
        beam((tx, ty + 0.1 * k, tz), (tx + ca * 2.1 * k, ty - 0.45 * k, tz + sa * 2.1 * k), 0.5 * k, 0x61cb8b, d=0.06)
    for sd in (-1, 1):
        box((0.3 * k, 0.3 * k, 0.3 * k), (tx + sd * 0.25 * k * dz, ty - 0.2 * k, tz - sd * 0.25 * k * dx), 0x9a6a46)

def flag_on_pole(at, h, colors, wave, w=0.32, fh=0.2):
    """A slim pole `h` tall and a flag of horizontal bands flying to +X off its
    top, hinged there; `wave` names the cloth's flap (set_motion.h)."""
    x, y, z = at
    box((0.05, h, 0.05), (x, y + h / 2, z), 0xfff6eb)
    with animated(wave, (x, y + h, z)):
        n = len(colors)
        for i, c in enumerate(colors):
            box((w, fh / n, 0.03), (x + w / 2 + 0.02, y + h - fh * (i + 0.5) / n, z), c)

# ---- Tidepool ----

@piece(1.0)
def rock_pool():
    # Tidepool: the big pool the tide left in the reef, deep blue in the
    # middle and pale at its shallow edge so it reads as water from the road,
    # grey boulders heaped up on the sea side (-X) and dropping low on the
    # road side so the water shows from the chase cam. A natural form, as big
    # as the reef it lies in (G). Its life is at a car's scale: a child with a
    # bucket working along the near shore and back, a parent crouched at the
    # water, two gulls on the high rock.
    G = 1.45
    disc(4.2 * G, (0.2 * G, 0.0, -0.3 * G), 'sky', segs=20, h=0.05)            # the shallows
    disc(3.6 * G, (-0.6 * G, 0.0, 1.2 * G), 'sky', segs=20, h=0.05)
    disc(3.2 * G, (0.0, 0.03, -0.1 * G), 'blue', segs=18, h=0.05)              # the deep middle
    disc(2.6 * G, (-0.7 * G, 0.03, 1.2 * G), 'blue', segs=18, h=0.05)
    for a, d, k, sq in ((2.5, 5.2, 1.5, 0.8), (3.1, 5.5, 1.9, 0.85), (3.75, 5.2, 1.4, 0.75),
                        (4.4, 5.0, 1.0, 0.7), (1.9, 5.0, 0.9, 0.7), (5.3, 4.8, 0.6, 0.6)):
        boulder((math.cos(a) * d * G, 0, math.sin(a) * d * G), k * G, yaw=a * 1.7, squash=sq)
    hi = (math.cos(3.0) * 5.7 * G, 1.3 * G, (math.sin(3.0) * 5.7 + 0.5) * G)
    boulder(hi, 0.9 * G, yaw=0.8, color='slate')
    boulder((-0.9 * G, 0, 0.8 * G), 0.5 * G, yaw=1.1)                          # breaking the surface
    # the near shore, where the shallows meet the sand on the road side
    a0, a1 = (math.cos(-0.7) * 6.6, 0.0, math.sin(-0.7) * 6.6), (math.cos(0.6) * 6.6, 0.0, math.sin(0.6) * 6.6)
    marker('path_pool_0', a0)
    marker('path_pool_1', a1)
    with animated('anim_path:c=pool:p=14:f=1#kid', a0):
        figure(a0, -math.pi / 2, shirt=0xffc044, legs=0x6794d9)
        box((0.08, 0.09, 0.08), (a0[0], 0.17, a0[2] + 0.17), 0xff5040)     # the bucket in hand
    figure((math.cos(0.05) * 6.4, 0.0, math.sin(0.05) * 6.4), math.pi, shirt=0x339cf2, legs=0x38383d, pose='crouch')
    box((0.3, 0.05, 0.18), (math.cos(0.05) * 6.75, 0.03, math.sin(0.05) * 6.75 + 0.3), 0xff7e44)   # a towel
    for k, a in enumerate((0.95, 1.25)):                                         # gulls on the far shore
        gull((math.cos(a) * 6.5, 0.0, math.sin(a) * 6.5), 0.3 * k,
             'anim_watch:r=24+hop:r=10:h=0.2#g%d' % k if k == 0 else 'anim_watch:r=24#g%d' % k)
    join_still('pool')

@piece(1.45)
def reef_shelf():
    # Tidepool: a stretch of the reef the low tide leaves bare, from the
    # waterline (-X) up the beach toward the road (+X), laid end to end round
    # the lap (tracks.js places it as a spine, each turned to the shore): flat
    # shelves of rock stepping down to the sea with pools of blue water caught
    # between them, a sea stack at the water's edge, weed and mussels on the
    # wet stone. A natural form, so it keeps its size; nothing living rides
    # on it at a scale a car would not give it. Blocks, not balls: a
    # flat-shaded ball costs ten blocks' vertices.
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
    join_still('reef')

@piece(1.0)
def crab_pots():
    # Tidepool: the crab fishers' landing above the reef, at a car's scale: a
    # blue shed with its door to the road (+X) and floats hung on its wall,
    # the boat hauled up beside it, creels stacked by the slip, a net drying
    # on two poles, and the fisher in yellow oilskins sorting the catch, who
    # turns to watch the cars go by.
    hut(1.2, 0.75, 1.0, (-0.6, 0, 0), 0x6794d9, 0xcf534f, t=0.2)
    for z in (-0.3, -0.05, 0.2):
        box((0.11, 0.11, 0.06), (-0.6 + z, 0.42, 0.55), 0xff7e44)            # floats on the wall
    boat((0.5, 0, -1.3), 0.25, 0xfff6eb, trim=0x339cf2)
    for (x, y, z, yw) in ((0.45, 0, 0.75, 0.1), (0.45, 0, 1.15, -0.05), (0.75, 0, 0.95, 0.4),
                          (0.45, 0.2, 0.95, 0.2), (0.6, 0.4, 0.95, -0.1)):
        creel((x, y, z), yw)
    for z in (1.6, 2.6):
        box((0.05, 0.62, 0.05), (-0.2, 0.31, z), 0x9a7b55)
    box((0.03, 0.32, 0.98), (-0.2, 0.42, 2.1), 'slate')                     # the net
    box((0.04, 0.04, 1.04), (-0.2, 0.6, 2.1), 0x9a7b55)
    with animated('anim_watch:r=22:d=70#fisher', (1.0, 0, 0.4)):
        figure((1.0, 0, 0.4), 0.0, shirt=0xffc044, legs=0x38383d, hair=0x38383d)
    join_still('landing')

# ---- Cove ----

@piece(1.0)
def pirate_camp():
    # Cove: the crew's camp ashore, at a car's scale: a thatched shelter on
    # its posts over the stores, two palms with a hammock slung
    # between them, a cook fire whose smoke goes up over the beach, a pirate
    # on a barrel by it and one at the treasure dig (the chest half out of its
    # hole, the spoil heap, the red X), barrels and a crate stacked by the
    # Jolly Roger, which flaps.
    for sx in (-1, 1):                                  # the shelter: four posts, a thatch
        for sz in (-1, 1):
            box((0.07, 0.8, 0.07), (sx * 0.4, 0.4, sz * 0.4), 0x8a6a46, yaw=0.2)
    for sz in (-1, 1):
        box((1.05, 0.08, 0.62), (0.0, 0.92, sz * 0.27), 0xd9b054, yaw=0.2, pitch=-sz * 0.5)
    kit('pirate', 'barrel', (-0.15, 0, -0.15), yaw=0.4, scale=0.2)
    kit('pirate', 'crate', (0.15, 0, 0.18), yaw=0.3, scale=0.25)
    # the hammock between two palms
    palm((-0.3, 0, -1.6), h=2.3, lean=0.2, yaw=math.radians(200))
    palm((-0.15, 0, -2.6), h=2.6, lean=0.25, yaw=math.radians(150))
    sl = sag((-0.28, 0.5, -1.72), (-0.17, 0.52, -2.48), 0.16, n=5)
    for i in range(4):
        beam(sl[i], sl[i + 1], 0.24, 0xfde4c7, d=0.04)
    # the cook fire, its smoke, a pirate on a barrel beside it
    for i in range(6):
        a = i / 6 * 2 * math.pi
        box((0.09, 0.07, 0.07), (1.2 + math.cos(a) * 0.2, 0.035, 0.4 + math.sin(a) * 0.2), 'grey', yaw=-a)
    with animated('anim_spin:w=2.4#fire', (1.2, 0.02, 0.4)):
        cyl(0.11, 0.24, (1.2, 0.02, 0.4), 0xff7e44, r2=0.02, segs=5)
        cyl(0.06, 0.3, (1.22, 0.02, 0.42), 0xffc044, r2=0.01, segs=5)
    marker('anim_smoke', (1.2, 0.3, 0.4))
    kit('pirate', 'barrel', (1.2, 0, -0.1), yaw=0.2, scale=0.16)
    figure((1.2, 0.2, -0.1), math.pi / 2, shirt=0xfff6eb, legs=0x38383d, hair=0xcf534f, pose='sit')
    # the dig: X marks the spot
    cyl(0.28, 0.16, (1.0, 0, 2.3), 'tan', r2=0.08, segs=7)                          # the spoil heap
    disc(0.26, (1.55, 0.0, 2.2), 0x9a6a46, segs=10, h=0.04)
    disc(0.17, (1.55, 0.01, 2.2), 'dark', segs=10, h=0.04)
    kit('pirate', 'chest', (1.55, -0.03, 2.2), yaw=math.radians(100), scale=0.17, roll=0.15)
    for gx, gz in ((1.8, 2.0), (1.75, 2.45)):
        box((0.06, 0.03, 0.06), (gx, 0.02, gz), 'yellow', yaw=gx)
    for a in (0.785, -0.785):
        box((0.06, 0.02, 0.45), (1.95, 0.02, 1.7), 0xff5040, yaw=a)
    figure((1.25, 0, 2.55), -0.6, shirt=0xcf534f, legs=0x38383d, hair=0x38383d)
    beam((1.36, 0.0, 2.36), (1.42, 0.3, 2.5), 0.03, 0x8a6a46)                    # the spade
    box((0.1, 0.12, 0.03), (1.35, 0.03, 2.33), 'grey', yaw=0.4)
    # stores by the flag
    kit('pirate', 'barrel', (0.3, 0, 1.0), yaw=0.9, scale=0.2)
    kit('pirate', 'barrel', (0.05, 0, 1.2), yaw=0.2, scale=0.2)
    kit('pirate', 'crate', (0.5, 0, 1.45), yaw=-0.3, scale=0.25)
    kit_flag('flag-pirate-high', (-0.45, 0, 0.9), math.radians(90), 0.42,   # cloth to the road, it flaps
             'anim_sway:a=x:d=24:p=2.1')
    join_still('camp')

@piece(1.0)
def shipwreck_ribs():
    # Cove: an old wreck run up the beach and picked clean, as long as the
    # pirate ship at anchor: the keel half buried, the ribs curving up out of
    # the sand in pairs, a run of hull planks still on the low side, the stem
    # post standing at the bow and the mast broken across the sand.
    wood = 0x8a6a46
    box((0.22, 0.18, 8.0), (0, 0.06, 0), wood)                                   # keel
    beam((0, 0.1, 3.9), (0, 0.8, 4.3), 0.18, wood)                               # stem
    beam((0, 0.8, 4.3), (0, 1.5, 4.4), 0.15, wood)
    beam((0, 0.1, -3.9), (0, 1.1, -4.2), 0.18, wood)                             # stern post
    for k in range(7):
        z = -3.3 + k * 1.1
        w = 1.0 - abs(k - 3) * 0.08                                              # beamiest midships
        for s in (-1, 1):
            hh = 0.55 if (s > 0) == (k % 3 == 1) else 1.0                        # some snapped short
            tube([(s * 0.06, 0.1, z), (s * 0.8 * w, 0.22, z), (s * 1.15 * w, 0.62, z),
                  (s * 1.22 * w, 0.62 + 0.55 * hh, z)], 0.07, wood, res=3, wire=True)
    # what is left of the planking, along the low side
    for y, x, z0, z1 in ((0.32, 0.95, -3.4, 2.9), (0.52, 1.1, -3.1, 1.7), (0.74, 1.18, -2.3, 0.5)):
        box((0.07, 0.17, z1 - z0), (-x, y, (z0 + z1) / 2), wood)
    box((0.07, 0.17, 2.6), (0.95, 0.32, -1.4), wood)
    beam((0.6, 0.12, 0.6), (3.4, 0.15, -1.6), 0.16, wood)                         # the mast
    beam((2.5, 0.15, -0.9), (2.9, 0.15, -0.1), 0.1, wood)                         # its yard
    gull((0.0, 0.15, 1.0), 0.8)                                                # on the keel
    join_still('wreck')

@piece(1.0)
def jetty():
    # Cove: the pirates' landing stage at a car's scale, from the sand (+X)
    # out over the shallows (-X) toward the ship: plank decking a little wider
    # than a car on square piles, a rowing boat tied at the far end where a
    # pirate keeps watch, barrels and a crate waiting at the near end.
    for k in range(22):                                                         # the decking
        box((0.42, 0.06, 0.8), (1.2 - k * 0.46, 0.4, 0), 0xb06041 if k % 3 else 0x9a6a46)
    for zs in (-0.32, 0.32):                                                    # the stringers
        box((10.2, 0.1, 0.1), (-3.7, 0.32, zs), 0x8a6a46)
    for k in range(6):
        for zs in (-0.42, 0.42):
            box((0.12, 1.0, 0.12), (1.2 - k * 1.95, -0.1, zs), 0x8a6a46)
    kit('pirate', 'boat-row-small', (-8.2, -0.02, 0.95), yaw=math.radians(90), scale=0.32)
    beam((-8.0, 0.25, 0.42), (-8.1, 0.2, 0.75), 0.06, 0xfde4c7)
    figure((-8.5, 0.43, 0.0), math.pi, shirt=0xfff6eb, legs=0x38383d, hair=0xcf534f)
    kit('pirate', 'barrel', (1.9, 0, -0.35), yaw=0.4, scale=0.2)
    kit('pirate', 'barrel', (2.1, 0, 0.05), yaw=1.2, scale=0.2)
    kit('pirate', 'crate', (1.9, 0, 0.55), yaw=0.2, scale=0.25)
    kit('pirate', 'crate', (1.9, 0.19, 0.55), yaw=0.6, scale=0.21)
    join_still('jetty')

# ---- Driftwood ----

@piece(1.0)
def driftwood_trunk():
    # Driftwood: a whole tree the storm brought in, at a car's scale (nine
    # cars long, a forest giant), stripped of its bark and lying along the verge where
    # the strand line begins: its root plate reared up at one end, two broken
    # limbs, smaller logs washed up beside it, a beachcomber sitting on it and
    # a gull on the roots who watches the cars and hops off as one goes by.
    L = 8.0
    wood, pale = 0x8a6a46, 0xb8a686
    spine = [(0.0, 0.34, -L / 2 + 0.3), (0.08, 0.32, -L / 4), (0.0, 0.28, 0), (-0.1, 0.23, L / 4), (0.04, 0.17, L / 2)]
    for i, rr in enumerate((0.36, 0.31, 0.26, 0.2)):
        rod(spine[i], spine[i + 1], rr, wood, r2=rr - 0.04, segs=7)
    cyl(0.85, 0.26, (0.0, 0.72, -L / 2 - 0.15), wood, segs=9, axis='along')    # the root plate
    for a, reach, droop in ((-110, 0.95, 0.25), (-50, 1.0, 0.15), (20, 1.0, 0.1), (85, 0.95, 0.2), (140, 0.85, 0.35)):
        ra = math.radians(a)
        dx, dy = math.sin(ra), math.cos(ra)
        rod((dx * 0.6, 0.72 + dy * 0.6, -L / 2 - 0.05), (dx * reach, max(0.08, 0.72 + dy * reach - droop), -L / 2 + 0.3),
            0.09, wood, r2=0.04, segs=5)
    rod((0.06, 0.3, L / 4), (0.5, 1.05, L / 4 + 0.4), 0.09, pale, r2=0.04, segs=6)    # two broken limbs
    rod((-0.15, 0.4, -0.4), (-0.85, 0.62, -0.1), 0.08, pale, r2=0.04, segs=6)
    rod((1.1, 0.1, 0.0), (1.7, 0.09, 1.7), 0.11, wood, r2=0.08)                    # smaller logs
    rod((-0.9, 0.08, 1.5), (-1.4, 0.07, 2.5), 0.08, pale, r2=0.06)
    figure((0.0, 0.5, 0.6), 0.0, shirt=0x6794d9, legs=0xf2bf99, pose='sit')
    gull((1.2, 0.0, -L / 2 + 0.6), 0.0, 'anim_watch:r=24+hop:r=10:h=0.2#gull')
    join_still('trunk')

@piece(1.0)
def strand_line():
    # Driftwood: a stretch of the line the storm tide left along the beach, at
    # a car's scale, laid end to end from the great trunk to the bonfire
    # (tracks.js places it as a spine, turned a little each time so it
    # wanders): whole trees thrown up by the storm, stripped and bleached, a
    # few of them piled on the others, one root plate reared up out of the
    # pile, and between them the wrack: weed, a lost float, a broken plank,
    # a crate the sea brought in. Trees are tree-sized here (the beach's own
    # palms stand two to three), so the line reads from the road. It runs
    # along Z.
    wood, pale, dark = 0x8a6a46, 0xb8a686, 0x7a5a3a
    def x_at(z):                       # the line wanders as it goes
        return 0.6 * math.sin(z * 0.45)
    for (z0, z1, dx0, dx1, r, y0, y1, c) in ((-4.8, -1.0, 0.3, -0.4, 0.2, 0.2, 0.17, pale),
                                            (-2.2, 2.4, -0.6, 0.2, 0.24, 0.24, 0.2, wood),
                                            (-1.6, 1.0, 0.5, -0.1, 0.16, 0.5, 0.44, pale),   # piled on the others
                                            (1.6, 4.9, 0.4, -0.3, 0.18, 0.18, 0.15, pale),
                                            (3.0, 4.6, -0.7, 0.5, 0.12, 0.12, 0.12, dark)):
        rod((x_at(z0) + dx0, y0, z0), (x_at(z1) + dx1, y1, z1), r, c, r2=r * 0.7, segs=7)
    # the root plate of the piled tree, reared up out of the line
    cyl(0.6, 0.16, (x_at(-2.3) - 0.6, 0.52, -2.3), wood, segs=9, axis='along')
    for a in (-0.9, 0.3, 1.6):
        rod((x_at(-2.3) - 0.6 + 0.35 * math.cos(a), 0.52 + 0.35 * math.sin(a), -2.25),
            (x_at(-2.3) - 0.6 + 0.75 * math.cos(a), max(0.05, 0.52 + 0.75 * math.sin(a) - 0.15), -2.0),
            0.05, wood, r2=0.03, segs=5)
    # the wrack between the trees
    for z in (-4.0, -0.6, 0.9, 3.4):
        box((0.5, 0.04, 0.24), (x_at(z) - 0.5, 0.02, z), 0x2f8f5b, yaw=0.6 * math.sin(z * 1.3))
    for z in (-3.0, 2.0):
        box((0.4, 0.04, 0.2), (x_at(z) + 0.55, 0.02, z), 0x7a5a3a, yaw=0.8 * math.cos(z))
    box((0.13, 0.13, 0.13), (x_at(-0.2) + 0.6, 0.065, -0.2), 0xff7e44)       # a fishing float
    box((0.12, 0.04, 0.75), (x_at(3.2) + 0.7, 0.02, 3.2), 0x9a6a46, yaw=0.5)   # a broken plank
    box((0.24, 0.2, 0.3), (x_at(-3.8) - 0.6, 0.1, -3.8), 0xb06041, yaw=0.4)   # a crate
    join_still('strand')

@piece(1.0)
def bonfire():
    # Driftwood: the beach fire at the end of the strand line, at a car's
    # scale: driftwood stood up in a cone in its ring of stones, the flames
    # licking round out of it and the yellow heart leaping, its smoke going up
    # over the beach; two logs drawn up as seats with three of the beach's
    # people round it, and a lean-to of driftwood poles behind them out of
    # the wind.
    for k in range(8):
        a = k / 8 * 2 * math.pi
        box((0.1, 0.08, 0.08), (math.cos(a) * 0.32, 0.04, math.sin(a) * 0.32), 0x868ba1, yaw=-a)
    disc(0.27, (0, 0.0, 0), 0x38383d, segs=10, h=0.03)
    with animated('anim_spin:w=2.6#flames', (0, 0.03, 0)):                     # tongues of flame, uneven, turning
        for (dx, dz, r, h) in ((0.04, 0.0, 0.14, 0.36), (-0.07, 0.06, 0.1, 0.28), (-0.03, -0.08, 0.09, 0.24)):
            cyl(r, h, (dx, 0.03, dz), 0xff7e44, r2=0.01, segs=5)
    with animated('anim_sway:a=x:d=20:p=0.8+bob:h=0.06:p=0.55#heart', (0.01, 0.03, 0.01)):
        cyl(0.08, 0.48, (0.01, 0.03, 0.01), 0xffc044, r2=0.01, segs=5)        # its yellow heart
    for k in range(6):
        a = k / 6 * 2 * math.pi + 0.3
        rod((math.cos(a) * 0.24, 0.02, math.sin(a) * 0.24), (math.cos(a) * 0.03, 0.42, math.sin(a) * 0.03),
            0.035, 0x8a6a46, segs=5)
    for z in (-0.75, 0.75):
        rod((-0.4, 0.09, z), (0.45, 0.09, z * 1.05), 0.09, 0x8a6a46, segs=7)
    figure((0.0, 0.17, -0.75), math.pi / 2, shirt=0xcf534f, legs=0x38383d, pose='sit')
    figure((0.15, 0.17, 0.75), -math.pi / 2, shirt=0x6794d9, legs=0xf2bf99, hair=0xffc044, pose='sit')
    figure((-0.62, 0, 0.1), 0.0, shirt=0x61cb8b, legs=0x38383d, pose='crouch')
    # the lean-to: driftwood poles against a ridge pole, out of the wind
    for z in (-0.6, 0.6):
        rod((-1.25, 0, z), (-1.25, 1.0, z), 0.05, 0xb8a686, segs=5)
    rod((-1.25, 1.0, -0.75), (-1.25, 1.0, 0.75), 0.05, 0xb8a686, segs=5)
    for i in range(6):
        z = -0.6 + i * 0.24
        rod((-1.25, 1.0, z), (-1.95, 0.0, z + 0.05 * (i % 2)), 0.05, 0x8a6a46 if i % 2 else 0xb8a686, segs=5)
    # an old sail over the poles: without it the frame reads as a swing
    box((1.22, 0.03, 1.5), (-1.64, 0.53, 0.0), 0x6794d9, roll=math.atan2(1.0, 0.7))
    marker('anim_smoke', (0.0, 0.5, 0.0))
    join_still('fire')

# ---- Riptide ----

@piece(1.0)
def lifeguard_tower():
    # Riptide: the surf patrol's station on the beach by the waterline, at a
    # car's scale: a white hut on stilts a car's height up, its lookout window
    # to the sea (+X), the ramp down its back toward the road, a red roof
    # under the patrol's flag and a red cross for the road to see. Round it:
    # the rescue board and the ring buoy, a rack of surfboards, the red rescue
    # boat pulled up toward the water, and the red-and-yellow flags that mark
    # where to swim. The lifeguard on the deck scans the water from side to
    # side; the flags fly.
    white, red, wood = 0xfff6eb, 0xff5040, 0x9a7b55
    S, top = 0.95, 0.95                       # the stilts' spread, the deck's height
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.09, top, 0.09), (sx * S / 2, top / 2, sz * S / 2), white)
    for sz in (-1, 1):                        # cross braces under the deck
        beam((-S / 2, 0.12, sz * S / 2), (S / 2, top - 0.12, sz * S / 2), 0.06, white)
    box((S + 0.4, 0.07, S + 0.3), (0.08, top + 0.035, 0), wood)               # the deck, its lookout end proud
    W, D, H, hx = 0.78, 0.85, 0.6, -0.12
    y0 = top + 0.07
    box((W, H, D), (hx, y0 + H / 2, 0), white)
    box((W + 0.03, 0.1, D + 0.03), (hx, y0 + 0.1, 0), red)                     # the red band
    box((0.06, 0.24, D * 0.72), (hx + W / 2 + 0.01, y0 + H * 0.64, 0), 0x8ecae6)  # the lookout window
    for sz in (-1, 1):
        box((W * 0.5, 0.2, 0.06), (hx + 0.08, y0 + H * 0.64, sz * (D / 2 + 0.01)), 0x8ecae6)
    for sz in (-1, 1):                        # the roof, peaked along the hut
        box((W + 0.3, 0.06, 0.5 * (D + 0.3) / math.cos(0.45)), (hx, y0 + H + 0.13, sz * (D + 0.3) / 4), red,
            pitch=-sz * 0.45)
    box((0.06, 0.24, 0.08), (hx - W / 2 - 0.02, y0 + H * 0.5, 0), red)          # the red cross, to the road
    box((0.06, 0.08, 0.24), (hx - W / 2 - 0.02, y0 + H * 0.5, 0), red)
    # the rail round the lookout end, a ring buoy on it
    for sz in (-1, 1):
        box((0.06, 0.3, 0.06), (0.08 + (S + 0.4) / 2 - 0.04, top + 0.2, sz * ((S + 0.3) / 2 - 0.04)), white)
        box((0.5, 0.06, 0.06), (0.08 + (S + 0.4) / 2 - 0.27, top + 0.35, sz * ((S + 0.3) / 2 - 0.04)), white)
    box((0.06, 0.06, S + 0.3), (0.08 + (S + 0.4) / 2 - 0.04, top + 0.35, 0), white)
    cyl(0.1, 0.06, (0.08 + (S + 0.4) / 2, top + 0.24, 0.3), 0xff7e44, segs=8, axis='across')
    # the ramp down its back to the sand, toward the road
    fx, bx = -1.85, -(S + 0.4) / 2 + 0.08
    for sz in (-1, 1):
        beam((fx, 0.02, sz * 0.2), (bx, top, sz * 0.2), 0.06, wood)
    for i in range(7):
        t = (i + 0.5) / 7
        box((0.16, 0.04, 0.44), (fx + (bx - fx) * t, 0.04 + (top - 0.02) * t, 0), wood,
            roll=math.atan2(top, bx - fx))
    # the patrol's flag over the roof
    flag_on_pole((hx - W / 2 + 0.06, y0 + H + 0.1, -D / 2 + 0.06), 0.5, (red, 0xffc044),
                 'anim_sway:a=z:d=24:p=1.8#roof')
    # the lifeguard on the lookout, scanning the water
    with animated('anim_sway:a=y:d=40:p=5.5#guard', (0.48, top + 0.07, 0)):
        figure((0.48, top + 0.07, 0), 0.0, shirt=red, legs=red, hair=0xffc044)
    # the rescue board against a stilt, the rack of surfboards beside the hut
    box((0.05, 0.62, 0.15), (S / 2 + 0.12, 0.3, -S / 2 - 0.1), red, roll=0.2)
    for z in (1.0, 1.6):
        box((0.06, 0.38, 0.06), (0.0, 0.19, z), wood)
    box((0.06, 0.06, 0.72), (0.0, 0.36, 1.3), wood)
    half = [(0.0, 0.0), (0.04, 0.01), (0.06, 0.08), (0.067, 0.2), (0.06, 0.33), (0.04, 0.43), (0.0, 0.48)]
    outline = [(z, y) for z, y in half] + [(-z, y) for z, y in reversed(half[1:-1])]
    for k, (c, st) in enumerate(((0xff5040, 0xfff6eb), (0x339cf2, 0xffc044), (0xffc044, 0xff5040))):
        zc = 1.08 + k * 0.22
        board = prism([(zc + z, y) for z, y in outline], 0.07, 0.035, c)
        board.rotation_euler.y = -0.2
        box((0.04, 0.36, 0.025), (0.07 - 0.24 * math.sin(0.2), 0.24, zc), st, roll=-0.2)
    # the rescue boat, pulled up toward the water
    boat((1.75, 0, -0.7), 0.15, red)
    # the swimming flags either side of the patrol's water
    for k, z in enumerate((-2.3, 2.6)):
        flag_on_pole((1.1, 0, z), 1.0, (red, 0xffc044), 'anim_sway:a=z:d=24:p=%.1f#swim%d' % (2.0 + 0.3 * k, k))
    join_still('tower')

@piece(1.0)
def parasol():
    # Riptide: the swimmers' stretch of beach by the patrol, at a car's scale:
    # striped umbrellas a little over a car's height in a loose row along the
    # sand, a towel under each with its sunbather, deck chairs turned to the
    # sea (+X), a cool box, a sandcastle, and two children by the water
    # throwing a beach ball between them.
    for (x, z, c) in ((0.1, -2.6, 0xff5040), (-0.3, -1.3, 0x339cf2), (0.2, 0.1, 0xffc044),
                      (-0.2, 1.4, 0xff5040), (0.15, 2.7, 0x22c46e)):
        umbrella((x, 0, z), 0.36, 0.58, (c, 0xfff6eb))
    for (x, z, c, yw, who) in ((0.35, -2.5, 0x22c46e, 0.1, 0xcf534f), (-0.05, -1.2, 0xff7e44, -0.15, None),
                               (0.45, 0.2, 0x339cf2, 0.05, 0x6794d9), (0.05, 1.5, 0xffc044, -0.1, 0xa878e8)):
        box((0.44, 0.03, 0.22), (x, 0.015, z), c, yaw=yw)
        if who:
            figure((x, 0.03, z), yw, shirt=who, legs=who, pose='lie')
    for (x, z, c) in ((0.55, 2.5, 0xff5040), (0.55, 2.9, 0x339cf2)):            # deck chairs to the sea
        beam((x - 0.12, 0.08, z), (x + 0.1, 0.03, z), 0.1, c, d=0.14)
        beam((x - 0.12, 0.08, z), (x - 0.25, 0.28, z), 0.1, c, d=0.14)
    box((0.16, 0.12, 0.12), (-0.5, 0.06, 0.6), 0x339cf2)                       # the cool box
    box((0.17, 0.03, 0.13), (-0.5, 0.135, 0.6), 0xfff6eb)
    for (dx, dz, s) in ((0, 0, 0.16), (0.1, 0.09, 0.1), (-0.09, 0.08, 0.1)):    # the sandcastle
        box((s, s * 0.8, s), (0.85 + dx, s * 0.4, -0.6 + dz), 0xe6d29a)
    figure((1.25, 0, -1.2), math.pi / 2, shirt=0xffc044, legs=0x339cf2)
    figure((1.25, 0, 0.0), -math.pi / 2, shirt=0x61cb8b, legs=0xff5040, hair=0x38383d)
    with animated('anim_bob:h=0.45:p=1.3#ball', (1.25, 0.0, -0.6)):          # thrown up and caught
        box((0.1, 0.1, 0.1), (1.25, 0.05, -0.6), 0xff5040)
    join_still('parasols')

@piece(1.0)
def buoy_line():
    # Riptide: the swimming line off the patrol's beach, at a car's scale: a
    # rope of red and white floats lying on the water between two marker
    # buoys, each flying a flag, and out past it two surfers, one sitting on
    # her board waiting for a wave and one riding in. The swell lifts it all:
    # the markers rock and bob, the line rides up and down in two lengths,
    # out of step, the riding surfer leans into the wave.
    for k, (s, flag) in enumerate(((-1, 0xff5040), (1, 0xffc044))):
        zb = s * 15.0
        with animated('anim_sway:a=z:d=20:p=3.1+bob:h=0.12:p=3.1#m%d' % k, (0, 0.0, zb)):
            cyl(0.17, 0.26, (0, 0.0, zb), 0xff5040, r2=0.11, segs=8)
            cyl(0.11, 0.08, (0, 0.26, zb), 0xfff6eb, r2=0.08, segs=8)
            box((0.05, 0.4, 0.05), (0, 0.5, zb), 0x2a2735)
            box((0.03, 0.14, 0.22), (0, 0.63, zb - s * 0.13), flag)
    for g in range(2):
        z0 = -14.6 + g * 14.6
        with animated('anim_bob:h=0.1:p=%.1f#f%d' % (2.6 + 0.5 * g, g), (0, 0.14, z0 + 7.3)):
            box((0.06, 0.06, 14.4), (0, 0.17, z0 + 7.3), 0xfff6eb)
            for k in range(10):                       # each float down through the water to the sand
                zf = z0 + 0.5 + k * 1.5
                box((0.12, 0.24, 0.16), (0, 0.12, zf), 0xfff6eb if (g * 10 + k) % 2 else 0xff5040)
    def board(x, z, color, yaw):                      # its keel down through the water to the sand
        c, s = math.cos(yaw), math.sin(yaw)
        box((0.13, 0.17, 0.5), (x, 0.085, z), color, yaw=yaw)
        box((0.09, 0.17, 0.12), (x + 0.25 * s, 0.085, z + 0.25 * c), color, yaw=yaw + math.pi / 4)
    with animated('anim_bob:h=0.14:p=3.4#sit', (4.5, 0.14, -6.0)):
        board(4.5, -6.0, 0xffc044, 0.3)
        figure((4.5, 0.17, -6.05), -1.3, shirt=0x38383d, legs=0x38383d, hair=0xffc044, pose='sit')
    with animated('anim_sway:a=z:d=14:p=2.2+bob:h=0.2:p=2.2#ride', (3.2, 0.14, 7.0)):
        board(3.2, 7.0, 0xff5040, -0.4)
        figure((3.2, 0.17, 7.0), math.pi - 0.4, shirt=0x339cf2, legs=0x38383d)

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

def draped(name, build):
    """Run `build` and make what it made ONE part named `drape_<name>`: the
    renderer lays each vertex on the ground as it DRAWS it (a 9 u grid's
    chords, a hand's breadth or more off the curve on a slope), so small
    things on a piece's own ground are built from y = 0 as if on the plain
    and land on the drawn slope instead of floating off it or sinking in."""
    before = set(bpy.context.scene.objects)
    build()
    return group([o for o in bpy.context.scene.objects if o not in before and o.type == 'MESH'],
                 'drape_' + name)

def turned(cx, cz, yaw, lx, lz):
    """A point (lx, lz) in a frame at (cx, cz) turned by `yaw` (box()'s sense:
    its +Z runs along (sin yaw, cos yaw))."""
    c, s = math.cos(yaw), math.sin(yaw)
    return cx + lx * c + lz * s, cz - lx * s + lz * c

# ---- the snow world at its real size -------------------------------------------
# A car is 0.9 long, and the ambient pines stand 2 to 4 tall: a unit is some
# four or five metres. Everything below is built at the size the real thing
# would be next to a real car, a little chunkier at most (a person or a
# penguin under half a unit, a cabin two or three across), so the pieces are
# authored in world units and grow 1. What is big in life (the ski mountain,
# the avalanche slopes, the glacier, the lake) is the track's terrain.

def person(x, y, z, coat, hat, yaw=0.0):
    """Someone standing, facing +X turned by `yaw`, at a person's size beside a
    car (0.48 tall): boots and legs, a coat, a head in a hat."""
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy):
        return (x + dx * c, y + dy, z - dx * s)
    box((0.1, 0.18, 0.14), at(0, 0.09), 0x38383d, yaw=yaw)
    box((0.13, 0.17, 0.18), at(0, 0.265), coat, yaw=yaw)
    box((0.09, 0.09, 0.09), at(0.01, 0.395), 0xf2bf99, yaw=yaw)
    box((0.1, 0.06, 0.1), at(0.0, 0.465), hat, yaw=yaw)

def seated(x, y, z, coat, hat, yaw=0.0):
    """Someone sitting (on a chair, a bucket), facing +X turned by `yaw`; `y`
    is the seat."""
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy):
        return (x + dx * c, y + dy, z - dx * s)
    box((0.2, 0.07, 0.14), at(0.07, 0.035), 0x38383d, yaw=yaw)       # thighs
    box((0.13, 0.17, 0.18), at(-0.02, 0.15), coat, yaw=yaw)
    box((0.09, 0.09, 0.09), at(-0.01, 0.28), 0xf2bf99, yaw=yaw)
    box((0.1, 0.06, 0.1), at(-0.02, 0.35), hat, yaw=yaw)

def skier(x, y, z, coat, hat):
    """A skier running toward +X, crouched over the skis, at a person's size:
    the skis, bent legs, a coat leaning in, a head and hat. Joined into one
    moving part by its caller."""
    box((0.5, 0.06, 0.13), (x + 0.03, y + 0.03, z), 0x2a2735)                 # the pair of skis
    box((0.1, 0.17, 0.13), (x - 0.01, y + 0.14, z), 0x38383d, roll=-0.35)    # bent legs
    box((0.14, 0.17, 0.17), (x + 0.03, y + 0.29, z), coat, roll=-0.45)       # leaning in
    box((0.09, 0.09, 0.09), (x + 0.09, y + 0.4, z), 0xf2bf99)
    box((0.1, 0.06, 0.1), (x + 0.09, y + 0.47, z), hat)

def sled(x, y, z, yaw, color=0xcf534f, L=0.6):
    """A sled `L` long along +X turned by `yaw`, its deck on two runners
    curling up at the front: three blocks."""
    c, s = math.cos(yaw), math.sin(yaw)
    box((L * 0.85, 0.06, 0.24), (x - L * 0.05 * c, y + 0.1, z + L * 0.05 * s), color, yaw=yaw)
    for sd in (-1, 1):
        box((L, 0.06, 0.06), (x + sd * 0.09 * s, y + 0.03, z + sd * 0.09 * c), 0x555b66, yaw=yaw)

def cabin_hut(w, h, d, at, wall, roof, yaw=0.0):
    """A small gabled hut at its real size (one or two units across), door on
    +X turned by `yaw`, trimmed as hut() is at the size of its parts: a grey
    plinth, a dark door in a white frame, a window either side, a chunky roof
    under a grey ridge."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def part(dx, dy, dz, size, color, pitch=0.0):
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw, pitch=pitch)
    part(0, h / 2, 0, (w, h, d), wall)
    part(0, 0.04, 0, (w + 0.08, 0.08, d + 0.08), 'grey')
    dw = d * 0.34
    part(w / 2 + 0.02, h * 0.37, 0, (0.06, h * 0.74 + 0.06, dw + 0.08), 'white')
    part(w / 2 + 0.045, h * 0.34, 0, (0.06, h * 0.68, dw), 'slate')
    for k in (-1, 1):
        part(0, h * 0.58, k * (d / 2 + 0.02), (w * 0.4 + 0.08, h * 0.3 + 0.08, 0.06), 'white')
        part(0, h * 0.58, k * (d / 2 + 0.045), (w * 0.4, h * 0.3, 0.06), 'slate')
        part(0, h + 0.1, k * (d + 0.2) / 4, (w + 0.2, 0.1, (d + 0.2) * 0.55), roof, pitch=-k * 0.6)
    part(0, h + 0.13 + 0.155 * (d + 0.2), 0, (w + 0.24, 0.09, 0.14), 'grey')

def pylon(at, h, yaw, ground=0.0):
    """A lift tower standing on `ground`, its crossarm at `h` across the line
    (the line runs along the tower's turned +Z), at a real tower's size: a
    column four units tall at most, the sheaves either side at the gauge."""
    x, _, z = at
    box((0.22, h - ground + 0.5, 0.22), (x, (h + ground - 0.5) / 2, z), 0x555b66, yaw=yaw)
    box((1.4, 0.12, 0.12), (x, h + 0.08, z), 0x555b66, yaw=yaw)
    for s in (-1, 1):
        gx, gz = turned(x, z, yaw, s * GAUGE, 0)
        box((0.12, 0.1, 0.4), (gx, h, gz), 0x2a2735, yaw=yaw)
    # the footing reaches well under the slope: the terrain is a 9 u grid's
    # chords across the curve this stands on, a little under it on a crest
    box((0.6, 0.6, 0.6), (x, ground - 0.2, z), 0x868ba1, yaw=yaw)

GAUGE = 0.55   # half the lift's gauge: the haul rope either side of the towers

def chair(at, yaw, color=0x3f7bd9, riders=()):
    """A two-seat chair hanging under the cable at `at`, facing down the line,
    half a unit across; `riders` are the coats of whoever sits in it. Returns
    its parts."""
    x, y, z = at
    # the hanger runs up past the rope to its grip: the rope is a smooth curve
    # through the towers, so between them it sits a little off the line
    parts = [box((0.06, 0.72, 0.06), (x, y - 0.06, z), 0x2a2735, yaw=yaw)]
    for (lx, ly, lz, size, c) in ((0, -0.45, 0.04, (0.52, 0.06, 0.2), color),
                                  (0, -0.35, -0.07, (0.52, 0.2, 0.06), color)):
        px, pz = turned(x, z, yaw, lx, lz)
        parts.append(box(size, (px, y + ly, pz), c, yaw=yaw))
    for i, coat in enumerate(riders):
        lx = (-0.13, 0.13)[i]
        px, pz = turned(x, z, yaw, lx, -0.01)
        parts.append(box((0.13, 0.16, 0.12), (px, y - 0.34, pz), coat, yaw=yaw))
        parts.append(box((0.09, 0.09, 0.09), (px, y - 0.21, pz), 0xf2bf99, yaw=yaw))
    return parts

def station(x, z, y, ground, yaw, roof=0xff5040):
    """A lift station at its real size: the bullwheel the haul rope turns
    round, at the gauge, under a red roof on four legs."""
    cyl(GAUGE + 0.03, 0.08, (x, y - 0.04, z), 0x555b66, segs=10)
    box((0.14, 0.52, 0.14), (x, y + 0.26, z), 0x555b66)
    top = y + 0.52
    for sx in (-1, 1):
        for sz in (-1, 1):
            px, pz = turned(x, z, yaw, sx * 0.8, sz * 0.55)
            box((0.1, top - ground + 0.3, 0.1), (px, (top + ground - 0.3) / 2, pz), 0x555b66, yaw=yaw)
    box((2.0, 0.12, 1.4), (x, top + 0.06, z), roof, yaw=yaw)

def snowcat(x, y, z, k=0.45):
    """A piste groomer facing +X, built like the cars: two broad tracks, a red
    body and cab with dark glass, the blade up front, the tiller behind,
    lamps on the roof. `k` sizes it (0.45: a real groomer's 1.5 units). Its
    pivot is under the middle of its tracks."""
    RED, DARK, GLASS = 0xcf534f, 0x38383d, 0x2f3a4a
    def b(size, dx, dy, dz, color):
        box([s * k for s in size], (x + dx * k, y + dy * k, z + dz * k), color)
    for s in (-1, 1):
        b((3.2, 0.7, 0.62), 0, 0.35, s * 0.82, DARK)
        b((3.0, 0.14, 0.66), 0, 0.74, s * 0.82, 0x868ba1)
    b((2.3, 0.6, 1.5), -0.1, 1.0, 0, RED)
    b((1.4, 1.0, 1.4), 0.15, 1.8, 0, RED)
    b((0.14, 0.62, 1.16), 0.86, 1.88, 0, GLASS)
    for s in (-1, 1):
        b((0.9, 0.55, 0.14), 0.2, 1.9, s * 0.71, GLASS)
    b((1.5, 0.14, 1.5), 0.15, 2.36, 0, 0xfff6eb)
    b((0.3, 0.2, 0.9), 0.5, 2.52, 0, 0xff7e44)
    b((0.3, 1.0, 2.5), 1.95, 0.6, 0, 0xfff6eb)                 # the blade
    b((0.7, 0.36, 2.2), -1.95, 0.4, 0, DARK)                    # the tiller

@piece(1.0)
def ski_lift():
    # Powder: a ski mountain standing along the road, its summit behind (-X)
    # and its long flank toward the road, so the lap drives past the whole of
    # it side-on. The mountain is the TRACK's terrain (SET_GROUND); this is
    # what stands on it, every part at its real size: a chairlift's towers
    # (four units at most) march up that flank on the diagonal from a valley
    # station by the road to the top station on the summit, the chairs (half
    # a unit across, skiers sat in most going up) riding up one side and down
    # the other round the haul rope's loop (anim_path); skiers run down the
    # slalom on the other diagonal to the finish banner on the flat, where
    # they ski into the timing hut (their way back up is out of sight, under
    # the snow, to the top hut); a groomer crawls up and down the piste. A
    # queue at the valley station, skis racked, the resort's chalets round
    # it on the flat by the road, pines on the flanks.
    H = set_ground('ski-lift')
    G = 1.35                                   # the old build's grow: where things stand on the mountain
    V, T = (12.0 * G, -22.0 * G), (-36.0 * G, -3.0 * G)            # valley and top wheels
    dx, dz = T[0] - V[0], T[1] - V[1]
    L = math.hypot(dx, dz)
    yaw = math.atan2(dx, dz)
    nx, nz = dz / L, -dx / L                          # across the line
    CAB = 3.0                                         # the cable over the snow at a tower
    y0, y1 = 1.1, H(*T) + 1.1                         # and at the wheels, where the chairs are boarded
    fr = [k / 8 for k in range(1, 8)]
    line = [(0.0, y0)] + [(f, H(V[0] + dx * f, V[1] + dz * f) + CAB) for f in fr] + [(1.0, y1)]
    def cy(f):
        for (fa, ya), (fb, yb) in zip(line[:-1], line[1:]):
            if fa <= f <= fb:
                return ya + (yb - ya) * (f - fa) / (fb - fa)
        return line[-1][1]
    for f in fr:
        x, z = V[0] + dx * f, V[1] + dz * f
        pylon((x, 0, z), cy(f), yaw, ground=H(x, z))
    # the rope in straight spans from sheave to sheave, a bar a span (a
    # third of the vertices a swept tube fine enough to lie on them costs)
    for s in (-GAUGE, GAUGE):
        for (fa, ya), (fb, yb) in zip(line[:-1], line[1:]):
            strut((V[0] + dx * fa + nx * s, ya, V[1] + dz * fa + nz * s),
                  (V[0] + dx * fb + nx * s, yb, V[1] + dz * fb + nz * s), 0.07, 0x2a2735)
    # the haul rope's loop: up one side, round the top wheel, down the other;
    # the renderer carries the chairs round it (anim_path), facing their way
    up = [(V[0] + dx * f + nx * GAUGE, y, V[1] + dz * f + nz * GAUGE) for f, y in line]
    down = [(V[0] + dx * f - nx * GAUGE, y, V[1] + dz * f - nz * GAUGE) for f, y in reversed(line)]
    for k, pt in enumerate(up + down):
        marker('path_lift_%d' % k, pt)
    COATS = (0xcf534f, 0x3f7bd9, 0x61cb8b, 0xffc044, 0xa878e8, 0xff7e44)
    for k in range(8):
        f = (k + 1) / 9                                # clear of the wheels, where the rope curls
        at = (V[0] + dx * f + nx * GAUGE, cy(f), V[1] + dz * f + nz * GAUGE)   # rest spot, any will do
        riders = ((COATS[k % 6], COATS[(k + 2) % 6]), (COATS[(k + 4) % 6],), ())[k % 3]
        with animated('anim_path:c=lift:p=60:o=%.3f:f=1#%d' % (k / 8, k), at):
            chair(at, math.pi / 2, (0x3f7bd9, 0xff5040)[k % 2], riders)   # faces +X, the way it rides
    # valley station on the flat by the road, its hut behind it, skis racked,
    # a queue waiting at the gate
    station(V[0], V[1], y0, 0.0, yaw)
    hx, hz = turned(V[0], V[1], yaw, 0.0, -2.0)
    cabin_hut(1.6, 0.9, 1.2, (hx, 0, hz), 0x9a7b55, 0xeef4f9, yaw=yaw + math.pi / 2)
    for k in range(5):
        px, pz = turned(V[0], V[1], yaw, 1.5, -0.6 + k * 0.16)
        box((0.06, 0.44, 0.07), (px, 0.22, pz), COATS[k], yaw=yaw, roll=0.15)
    for k in range(3):
        px, pz = turned(V[0], V[1], yaw, -0.25 + 0.3 * k, 1.3 + 0.12 * (k % 2))
        person(px, 0, pz, COATS[k + 1], COATS[k + 3], yaw=yaw - math.pi / 2)
    # the resort's chalets round the valley station, on the flat toward the road
    for (lx, lz, w, d, wall, ry) in ((4.5, -3.0, 2.2, 1.6, 0x9a5f3c, 0.3), (5.5, 1.2, 1.8, 1.4, 0xcf534f, -0.2),
                                     (2.6, 4.2, 2.0, 1.5, 0x9a7b55, 0.5)):
        cabin_hut(w, 0.95, d, (V[0] + lx, 0, V[1] + lz), wall, 0xeef4f9, yaw=ry)
    for k in range(2):
        person(V[0] + 3.2 + 0.5 * k, 0, V[1] - 0.6 + 0.9 * (k % 2), COATS[k], COATS[(k + 2) % 6], yaw=1.2 * k)
    # top station on the summit, its hut behind it
    station(T[0], T[1], y1, H(*T) - 0.3, yaw)
    tx, tz = turned(T[0], T[1], yaw, 0.0, 2.0)
    cabin_hut(1.6, 0.9, 1.2, (tx, H(tx, tz) - 0.1, tz), 0x9a7b55, 0xeef4f9, yaw=yaw)
    # the slalom down the other diagonal to the finish on the flat
    S0, F = (-6.0 * G, 5.0 * G), (12.0 * G, 21.0 * G)
    px_, pz_ = F[0] - S0[0], F[1] - S0[1]
    pl = math.hypot(px_, pz_)
    pyaw = math.atan2(px_, pz_)
    qx, qz = pz_ / pl, -px_ / pl
    gates = []
    for k in range(6):
        f = 0.08 + k * 0.155
        s2 = 0.9 if k % 2 else -0.9
        x, z = S0[0] + px_ * f + qx * s2, S0[1] + pz_ * f + qz * s2
        gates.append((x - qx * s2 * 0.3, z - qz * s2 * 0.3))     # the skier's line, inside each gate
        c = 0xff5040 if k % 2 == 0 else 0x339cf2
        g = H(x, z)
        for e in (-0.22, 0.22):
            ex, ez = turned(x, z, pyaw, e, 0)
            box((0.06, 0.8, 0.06), (ex, g + 0.12, ez), c, yaw=pyaw)    # sunk past the grid's chords
        box((0.44, 0.24, 0.06), (x, g + 0.4, z), c, yaw=pyaw)
    for e in (-1.6, 1.6):
        ex, ez = turned(F[0], F[1], pyaw, e, 0)
        box((0.14, 1.5, 0.14), (ex, H(ex, ez) + 0.55, ez), 0x555b66, yaw=pyaw)
    box((3.4, 0.4, 0.08), (F[0], H(*F) + 1.15, F[1]), 0x339cf2, yaw=pyaw)
    box((1.4, 0.24, 0.1), (F[0], H(*F) + 1.15, F[1]), 0xfff6eb, yaw=pyaw)
    fx, fz = turned(F[0], F[1], pyaw, 2.4, 1.2)                          # the timing hut
    cabin_hut(1.1, 0.8, 1.0, (fx, H(fx, fz) - 0.05, fz), 0x9a7b55, 0xeef4f9, yaw=pyaw - math.pi / 2)
    # the skiers' loop: out of the top hut, over the summit to the start, the
    # gates down the slalom, through the finish and into the timing hut, then
    # back up out of sight, under the snow, to the top hut
    run = [(tx, tz), (-32.0 * G, 12.0 * G)] + gates + [F, (fx, fz)]
    surf = []
    for (ax, az), (bx, bz) in zip(run[:-1], run[1:]):
        n = max(1, int(math.hypot(bx - ax, bz - az) / 2.5))
        for i in range(n):
            x, z = ax + (bx - ax) * i / n, az + (bz - az) * i / n
            surf.append((x, H(x, z) + 0.02, z))
    surf.append((fx, H(fx, fz) + 0.02, fz))
    under = [(x, H(x, z) - 1.6, z) for (x, _, z) in reversed(surf[::3] + [surf[-1]])]
    for k, pt in enumerate(surf + under):
        marker('path_ski_%d' % k, pt)
    for k in range(4):
        x, y, z = surf[3 + k * 4]
        with animated('anim_path:c=ski:p=70:o=%.3f#%d' % (k / 4, k), (x, y, z)):
            skier(x, y, z, COATS[k], COATS[(k + 3) % 6])
    # the piste runs on up from the slalom to the top station (its blue wash
    # is the terrain's, SET_GROUND's `paint`); a groomer works it, crawling up
    # one side and back down the other (anim_path, pitched to the slope)
    groom = [(-32.0 * G, 12.0 * G), S0, F]
    def along(off, back):
        pts = []
        for (ax, az), (bx, bz) in zip(groom[:-1], groom[1:]):
            l = math.hypot(bx - ax, bz - az)
            nx_, nz_ = -(bz - az) / l, (bx - ax) / l
            for i in range(8):
                f = i / 8
                pts.append((ax + (bx - ax) * f + nx_ * off, az + (bz - az) * f + nz_ * off))
        pts.append((groom[-1][0] + nx_ * off, groom[-1][1] + nz_ * off))
        return list(reversed(pts)) if back else pts
    loop = along(-3.4, False) + along(3.4, True)
    for k, (x, z) in enumerate(loop):
        marker('path_groom_%d' % k, (x, H(x, z) + 0.02, z))
    x, z = loop[3]
    with animated('anim_path:c=groom:p=60:f=2#cat', (x, H(x, z) + 0.02, z)):
        snowcat(x, H(x, z) + 0.02, z)
    # pines on the flanks, clear of the lift line and the piste, the size of
    # the ambient ones
    for x, z, k in ((-50.0, -30.0, 1.9), (-12.0, 20.0, 1.8)):
        x, z = x * G, z * G
        pine((x, H(x, z) - 0.6, z), k)   # sunk past the grid's chords

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
    b((0.6, 0.85, 0.7), 0.05, 1.55, 0.0, coat, roll=-0.25)             # the coat, leaning in
    b((0.3, 0.3, 2.3), 0.05, 1.72, 0.0, coat)                           # arms out
    b((0.5, 0.5, 0.5), 0.2, 2.32, 0.0, SKIN)                            # the head
    b((0.56, 0.3, 0.56), 0.18, 2.64, 0.0, hat)                          # the hat

def shanty(x, z, color, yaw=0.0, pipe=False):
    """An ice-fishing shanty at its real size: a box hut on skids, a snowed
    roof, a dark door to +X turned by `yaw`, maybe a stovepipe."""
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s, dy, z - dx * s + dz * c)
    box((0.66, 0.06, 0.5), at(0, 0.03, 0), 0x6e4a32, yaw=yaw)
    box((0.6, 0.48, 0.46), at(0, 0.3, 0), color, yaw=yaw)
    snowy(box((0.7, 0.08, 0.56), at(0, 0.58, 0), 0xfff6eb, yaw=yaw, roll=0.12), 0.5)
    box((0.06, 0.32, 0.2), at(0.31, 0.24, 0), 0x38383d, yaw=yaw)
    if pipe:
        box((0.07, 0.24, 0.07), at(-0.18, 0.72, 0.12), 0x555b66, yaw=yaw)

@piece(1.0)
def frozen_lake():
    # Flurry: a frozen lake at the bottom of the land, the snowbanks round it
    # and the plain it lies on are the track's terrain (SET_GROUND), and the
    # road crosses its east edge on its stilts (+X, toward the road). Built in
    # world units, everything on the ice at its real size beside a car: six
    # skaters (half a unit tall) glide round a rink on the west ice
    # (anim_path); out on the north-west ice a little village of fishing
    # shanties in bright colours, a fisher sat by his hole jigging his rod; a
    # snowman on the ice by the bank.
    R = 15.0
    disc(R, (0, 0, 0), 0xa9d7ee, segs=40, h=0.06)
    disc(R - 3.0, (0, 0.01, 0), 0x8ecae6, segs=32, h=0.06)          # the clear ice in the middle
    # the rink: an oval on the west ice, the skaters spread round it
    N = 14
    rc, rx, rz = (-2.0, 4.0), 4.5, 5.5
    for j in range(N):
        a = j / N * 2 * math.pi
        marker('path_rink_%d' % j, (rc[0] + math.cos(a) * rx, 0.07, rc[1] + math.sin(a) * rz))
    for n, (coat, hat) in enumerate(((0xcf534f, 0x3f7bd9), (0x3f7bd9, 0xffc044), (0x61cb8b, 0xcf534f),
                                     (0xa878e8, 0xfff6eb), (0xff7e44, 0x3f7bd9), (0xfff6eb, 0xcf534f))):
        a = n / 6 * 2 * math.pi
        at = (rc[0] + math.cos(a) * rx, 0.07, rc[1] + math.sin(a) * rz)
        with animated('anim_path:c=rink:p=16:o=%.3f:f=1#%d' % (n / 6, n), at):
            skater(at[0], at[1], at[2], coat, hat, k=0.19)
    # the shanty village on the north-west ice, a fishing hole by each door;
    # all of it inside nine units of the middle, where the drawn ice is flat
    # (past that the ground's 9 u grid rises toward the banks over the ice)
    for (x, z, c, yw, pipe) in ((-5.25, -4.5, 0xcf534f, 0.2, True), (-6.45, -3.15, 0x3f7bd9, -0.3, False),
                                (-4.2, -6.0, 0x61cb8b, 0.5, False), (-6.9, -5.55, 0xffc044, 0.1, True),
                                (-4.8, -2.55, 0xa878e8, -0.6, False), (-3.15, -4.2, 0xff7e44, 0.3, False),
                                (-5.7, -7.2, 0x3f7bd9, 0.4, False)):
        shanty(x, z, c, yw, pipe)
        hx, hz = turned(x, z, yw, 0.62, 0.15)
        box((0.24, 0.02, 0.24), (hx, 0.075, hz), 0x2f3a4a, yaw=yw)        # its hole
    sx, sz = -2.2, -6.6                                                  # the fisher out in the open
    box((0.3, 0.02, 0.3), (sx + 0.42, 0.075, sz), 0x2f3a4a)
    cyl(0.09, 0.16, (sx, 0.07, sz), 0x555b66, segs=8)                    # his bucket
    seated(sx, 0.23, sz, 0x6e4a32, 0xffc044)
    with animated('anim_sway:a=z:d=22:p=1.6#rod', (sx + 0.1, 0.36, sz)):
        box((0.48, 0.03, 0.03), (sx + 0.32, 0.42, sz), 0x2a2735, roll=0.4)
    # on the ice by the rink, a snowman in a hat
    snowman((-7.6, 0.07, 5.0), 0.15, hat=True)

@piece(1.0)
def snow_fort():
    # Glacier: a big snow fort built of cut snow blocks laid in courses (the
    # rounding and the shading tell them apart), at a real fort's size beside
    # a car: four units square, walls a unit tall with battlements, the gateway
    # open to the road (+X), a round lookout tower of blocks at the back corner
    # flying a flag, snowballs piled ready, a snowman keeping watch by the
    # gate. The moraine it stands on is the track's terrain.
    SNOW = 0xf3f7fb
    H = 2.0                                                        # half a side
    BL, BH, BD = 1.0, 0.45, 0.5                                     # a block: long, high, deep
    def cut(size, at, yaw=0.0, round=True):
        o = snowy(box(size, at, SNOW, yaw=yaw), 0.4)
        if round:                                                  # what the eye reads: the top
            o['round'] = 0.1
    for c in range(2):                                             # two courses, the joints staggered
        y = BH / 2 + c * BH
        for k in range(4):
            t = -H + BL / 2 + k * BL + (BL / 2 if c % 2 else 0.0)
            if t > H - 0.3:
                continue
            if abs(t) > 0.6:
                cut((BD, BH, BL), (H, y, t), round=c > 0)          # the front wall, the gate left open
            cut((BD, BH, BL), (-H, y, t), round=c > 0)             # the back wall
            for sz in (-1, 1):
                cut((BL, BH, BD), (t, y, sz * H), round=c > 0)     # the side walls
    for sx in (-1, 1):                                             # the corners
        for sz in (-1, 1):
            cut((BD, 2 * BH, BD), (sx * H, BH, sz * H))
    for t in (-1.0, 1.0):                                          # battlements
        cut((BD, 0.3, 0.5), (-H, 2 * BH + 0.15, t))
        for sz in (-1, 1):
            cut((0.5, 0.3, BD), (t, 2 * BH + 0.15, sz * H))
    for sz in (-1, 1):
        cut((BD, 0.3, 0.5), (H, 2 * BH + 0.15, sz * 1.3))
    tx, tz, R = -H, -H, 0.75                                       # the lookout tower
    for c in range(4):
        n = 5
        for k in range(n):
            a = (k + 0.5 * (c % 2)) / n * 2 * math.pi
            cut((0.4, BH, 0.9), (tx + math.cos(a) * R, BH / 2 + c * BH, tz + math.sin(a) * R), yaw=-a,
                round=c == 3)
    snowy(cyl(R + 0.25, 0.14, (tx, 4 * BH, tz), SNOW, segs=12), 0.4)
    box((0.08, 1.0, 0.08), (tx, 4 * BH + 0.5, tz), 0xfff6eb)
    box((0.4, 0.26, 0.06), (tx + 0.24, 4 * BH + 0.86, tz), 0xff5040)
    for (x, z) in ((H - 0.9, 0.9), (H + 0.9, -1.4)):              # snowballs: four and one on top
        for dx, dz in ((-0.1, -0.1), (0.1, -0.1), (-0.1, 0.1), (0.1, 0.1)):
            snowy(box((0.17, 0.17, 0.17), (x + dx, 0.085, z + dz), SNOW), 0.4)
        snowy(box((0.17, 0.17, 0.17), (x, 0.24, z), SNOW, yaw=0.6), 0.4)
    snowman((H + 1.0, 0, 1.2), 0.15, hat=True)
    person(H + 0.6, 0, 0.0, 0xcf534f, 0x3f7bd9, yaw=0.3)
    person(H - 0.7, 0, -0.6, 0x3f7bd9, 0xffc044, yaw=2.6)
    join_still('fort')

@piece(1.0)
def avalanche_slide():
    # Avalanche: a broad mountain behind the verge (summit at -X) whose face
    # let go: the broken crown near the top, the bare rock of the chute below
    # it, and the debris fan of tumbled snow blocks and rocks spread out at
    # its foot toward the road, a pine snapped and its trunk thrown down, a
    # buried sled. Forest stands either side of the chute. The mountain and
    # the fan are the track's terrain (SET_GROUND); this is what lies on them,
    # at its real size: blocks of snow the size of a car or less, pines as
    # tall as the ambient ones.
    H = set_ground('avalanche-slide')
    G = 1.45                                   # the old build's grow: where things lie on the slope
    # What lies on the face and the fan is draped: built from y = 0 as if on
    # the plain, each vertex laid on the slope as the renderer draws it (its
    # 9 u grid's chords stray a unit off the curve), so no block floats and
    # none is swallowed.
    def debris():
        for z in (-2.6, 0.0, 2.6):                 # the crown: the broken edge of the slab
            x = (-28.0 + 0.4 * abs(z)) * G
            box((1.3, 1.4, 4.0), (x, 0.3, z * G), 0x868ba1, yaw=0.15 * z)
        # the chute: the scar the slab left, scoured to grey rock, lying on the
        # face and widening as it runs down into the fan, whose blocks cover
        # its end; fine enough to follow the drawn slope, and lifted a little
        # over it so the grid's folds between its corners stay under
        xs = [(-27.0 + 1.65 * i) * G for i in range(15)]
        verts = []
        for i, x in enumerate(xs):
            w = (1.8 + 0.225 * i) * G
            for f in (-1.0, -0.5, 0.0, 0.5, 1.0):
                verts.append((x, 0.35 - 0.1 * abs(f), f * w + 0.3 * G * math.sin(i / 2)))
        faces = [(5 * i + j, 5 * i + j + 1, 5 * (i + 1) + j + 1, 5 * (i + 1) + j)
                 for i in range(len(xs) - 1) for j in range(4)]
        poly(verts, faces, 0x9aa1b4)
        for i, x in enumerate((-20.0, -12.0, -4.0)):
            x *= G
            z = 0.4 * G * (i % 2 * 2 - 1)
            rock((x, -0.3, z), 0.9, yaw=i * 1.9)
        # the debris fan: tumbled snow blocks over it, the runout thinning on
        # toward the road (+X). The fan stops a grid cell short of the road,
        # where the deck's cap would hold the land under it.
        for i, (x, z, k) in enumerate([(-6.0, 0.5, 1.5), (-3.0, -2.5, 1.4), (-1.0, 3.0, 1.3), (2.0, -1.0, 1.7),
                                       (3.5, 2.5, 1.4), (4.0, -3.5, 1.3), (5.5, 0.5, 1.2), (6.5, -2.0, 1.0),
                                       (7.0, 3.0, 0.9), (2.5, 4.5, 1.1), (1.5, -4.5, 1.2), (8.0, 0.0, 0.8),
                                       (4.8, 5.2, 0.8), (6.0, -6.0, 0.9), (7.5, 5.8, 0.8), (-4.5, 3.8, 1.0),
                                       (0.0, -6.0, 0.9), (-2.0, 6.5, 0.8), (3.0, 7.0, 0.7), (8.5, -4.0, 0.7)]):
            x, z, k = x * G, z * G, k * 0.5
            snowy(box((1.3 * k, 0.9 * k, 1.1 * k), (x, 0.15 * k, z), 0xf3f7fb,
                      yaw=i * 1.1, roll=0.3 * math.sin(i * 2.3), pitch=0.25 * math.cos(i * 1.7)), 0.5)
        for i, (x, z, k) in enumerate([(3.0, 0.8, 1.0), (5.0, -1.2, 0.8), (1.0, 2.2, 0.9), (6.2, 2.0, 0.7),
                                       (-4.5, -1.0, 0.9)]):
            rock((x * G, -0.2, z * G), k, yaw=i * 1.4)
        # the snapped pine: its stump on the slope, the trunk thrown down the fan
        cyl(0.18, 0.8, (-1.0 * G, -0.3, -3.2 * G), 0x7a5a3a, r2=0.15, segs=6)
        cyl(0.16, 3.2, (5.6 * G, 0.05, -5.0 * G), 0x7a5a3a, r2=0.09, segs=6, axis='across', yaw=0.5)
        sled(5.0 * G, -0.05, 3.6 * G, 0.8, 0xcf534f, L=0.5)
    draped('debris', debris)
    x, z = 6.5 * G, -6.4 * G
    pine((x, H(x, z) - 0.3, z), 1.7)
    # forest either side of the chute
    for x, z, k in ((-12.0, -12.0, 1.9), (-6.0, -16.0, 1.8), (-22.0, -14.0, 1.8), (-12.0, 12.0, 1.9),
                    (-5.0, 15.0, 1.8), (-22.0, 14.0, 1.7), (-34.0, -28.0, 1.9), (-32.0, 30.0, 1.9)):
        x, z = x * G, z * G
        pine((x, H(x, z) - 0.6, z), k)

def igloo_dome(cx, cz, R, yaw, blocks=True):
    """An igloo of snow blocks at (cx, cz), `R` its radius (a real one is
    under a unit and a half across): rings of cut blocks stepping in as they
    rise and closing over the top, or (`blocks` off) the packed dome alone;
    a tunnel of blocks out toward +X turned by `yaw`, its doorway dark."""
    snowy(sphere(R * 0.92, (cx, 0, cz), 0xf3f7fb, subdiv=1), 0.4)     # the packed snow behind the joints
    if blocks:
        rows = 2
        span = math.pi / 2 * 0.7 / rows
        for row in range(rows):
            phi = (row + 0.5) * span
            rr = R * math.cos(phi)
            n = max(5, round(2 * math.pi * rr / 0.5))
            for k in range(n):
                a = (k + 0.5 * (row % 2)) / n * 2 * math.pi
                snowy(box((0.14, R * span * 0.94, 2 * math.pi * rr / n * 0.94),
                          (cx + math.cos(a) * rr, R * math.sin(phi), cz + math.sin(a) * rr), 0xf3f7fb,
                          yaw=-a, roll=-phi * 0.85), 0.4)
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (cx + dx * c + dz * s, dy, cz - dx * s + dz * c)
    T = R * 0.45                                                      # the tunnel's half-width
    snowy(box((0.7 * R, 0.62 * R, 2.6 * T), at(R * 1.05, 0.31 * R, 0), 0xf3f7fb, yaw=yaw), 0.4)
    box((0.06, 0.45 * R, 1.1 * T), at(R * 1.42, 0.22 * R, 0), 0x2f3a4a, yaw=yaw)

@piece(1.0)
def igloo():
    # Glacier: an igloo camp out on the ice at its real size beside a car:
    # a big igloo of cut blocks (a unit and a half across) and two smaller
    # domes, their tunnels toward the road (+X), a dog sled with its team
    # resting in the snow, a rack of fish drying, the
    # hunter by his door and a snowman.
    igloo_dome(0.0, 0.0, 0.75, 0.0)
    igloo_dome(-1.2, 1.7, 0.5, -0.5, blocks=False)
    igloo_dome(-1.6, -1.4, 0.45, 0.4, blocks=False)
    sled(1.6, 0, 1.2, 0.2, 0x9a7b55, L=0.7)
    for k in range(3):                                                 # the team, lying down
        x, z = 1.75 + (k // 2) * 0.32, 0.55 + (k % 2) * 0.28 - 0.2 * (k // 2)
        box((0.24, 0.1, 0.11), (x, 0.06, z), (0x868ba1, 0x38383d, 0xfff6eb, 0x868ba1)[k], yaw=0.2)
        box((0.09, 0.09, 0.09), (x + 0.14, 0.12, z), (0x868ba1, 0x38383d, 0xfff6eb, 0x868ba1)[k], yaw=0.2)
    for z in (-1.6, -0.9):                                             # the drying rack
        box((0.06, 0.5, 0.06), (0.7, 0.25, z), 0x7a5a3a)
    box((0.05, 0.05, 0.85), (0.7, 0.48, -1.25), 0x7a5a3a)
    for k in range(3):
        box((0.04, 0.16, 0.08), (0.72, 0.38, -1.48 + k * 0.22), 0x8ecae6)
    person(1.3, 0, -0.2, 0x9a7b55, 0x38383d, yaw=0.2)
    snowman((-0.4, 0, 1.3), 0.14)
    snow_heap((-2.4, 0, 0.3), 0.6, yaw=1.0)
    join_still('camp')

@piece(1.0)
def windsock():
    # Avalanche's patrol post, at its real size beside a car: the avalanche
    # patrol's red hut, a windsock streaming on its mast (one and a half
    # units) and swinging round it as the wind veers off the mountain, a
    # slatted weather screen on legs, a snow stake banded to read the depth,
    # a rescue sled, two of the patrol with their probes by the door.
    cabin_hut(1.5, 0.85, 1.2, (-0.4, 0, -0.6), 0xcf534f, 0xeef4f9)
    box((0.08, 1.6, 0.08), (1.0, 0.8, 0.9), 0x555b66)
    with animated('anim_sway:a=y:d=40:p=5.5#sock', (1.0, 1.55, 0.9)):
        box((0.06, 0.06, 0.06), (1.03, 1.55, 0.9), 0x2a2735)
        for k in range(4):
            c = 0xff5040 if k % 2 == 0 else 0xfff6eb
            cyl(0.1 - k * 0.012, 0.15, (1.06 + k * 0.15, 1.55 - k * 0.02, 0.9), c,
                r2=0.09 - k * 0.012, segs=8, axis='across', smooth=False)
    for sx in (-0.1, 0.1):                                         # the weather screen
        for sz in (-0.1, 0.1):
            box((0.05, 0.42, 0.05), (1.0 + sx, 0.21, -0.4 + sz), 0x555b66)
    box((0.28, 0.22, 0.28), (1.0, 0.53, -0.4), 0xfff6eb)
    box((0.34, 0.06, 0.34), (1.0, 0.67, -0.4), 0x555b66)
    for k in range(5):                                             # the snow stake
        box((0.08, 0.2, 0.08), (0.3, 0.1 + k * 0.2, 1.4), 0xff5040 if k % 2 == 0 else 0xfff6eb)
    sled(0.2, 0, 0.6, 0.4, 0xff7e44, L=0.6)
    person(0.6, 0, -0.1, 0xff7e44, 0x38383d, yaw=0.4)
    person(0.75, 0, 0.3, 0xff7e44, 0xcf534f, yaw=-0.3)
    for (x, z) in ((0.72, -0.18), (0.88, 0.22)):                   # their probes
        box((0.04 + 0.02, 0.6, 0.04 + 0.02), (x, 0.3, z), 0x868ba1)
    snow_heap((-1.6, 0, 0.6), 0.6, yaw=0.2)

def woodpile(x, z, k=0.3):
    """Firewood stacked under a lean-to, cut ends to +X, an axe in the block
    beside it; `k` sizes it (0.3: a real woodpile)."""
    for row in range(3):
        for j in range(4 - row):
            zz = z + (-0.9 + j * 0.6 + row * 0.3) * k
            y = (0.3 + row * 0.52) * k
            cyl(0.3 * k, 2.2 * k, (x - 1.1 * k, y, zz), 0x8a6a46, segs=6, axis='across')
    for s in (-1, 1):
        box((0.2 * k, 2.4 * k, 0.2 * k), (x + 1.4 * k, 1.2 * k, z + s * 1.5 * k), 0x8a6a46)
        box((0.2 * k, 1.8 * k, 0.2 * k), (x - 1.4 * k, 0.9 * k, z + s * 1.5 * k), 0x8a6a46)
    snowy(box((3.4 * k, 0.2 * k, 3.5 * k), (x, 2.2 * k, z), 0xeef4f9, roll=-0.2))
    cyl(0.5 * k, 0.6 * k, (x + 2.4 * k, 0, z + 1.6 * k), 0x8a6a46, segs=8)

def log_cabin_at(cx, cz, k=1.0, smoke=False):
    """A log cabin at (cx, cz), door on +X, built at `k` of the old 4.2 unit
    cabin (0.55: a real cabin, two and a half units across): each wall its
    own logs whose ends cross out past the corners, a snowed gable roof, a
    stone chimney, lit windows."""
    W, D, H = 4.2 * k, 3.4 * k, 2.0 * k
    L = 0.4 * k                                    # a log
    box((W + 0.3 * k, 0.25 * k, D + 0.3 * k), (cx, 0.12 * k, cz), 0x868ba1)
    box((W - 0.2 * k, H, D - 0.2 * k), (cx, H / 2 + 0.1 * k, cz), 0x6e4a32)    # the chinking
    p = (H - 0.15 * k) / 4
    for j in range(4):
        for s in (-1, 1):
            box((L, L, D + 0.5 * k), (cx + s * (W / 2 - L / 2), 0.25 * k + (j + 0.5) * p, cz), 0x8a5a3a)
            if j < 3:
                box((W + 0.5 * k, L, L), (cx, 0.25 * k + (j + 1) * p, cz + s * (D / 2 - L / 2)), 0x9a5f3c)
    for s in (-1, 1):
        prism([(cz + D / 2 - 0.05 * k, H + 0.1 * k), (cz - D / 2 + 0.05 * k, H + 0.1 * k),
               (cz, H + 0.1 * k + (D / 2) * math.tan(0.6))], cx + s * (W / 2 - 0.1 * k), 0.2 * k, 0x8a5a3a)
    ridge = H + 0.1 * k + (D / 2) * math.tan(0.6)
    run = D / 2 + 0.45 * k
    for s in (-1, 1):
        snowy(box((W + 0.8 * k, 0.26 * k, run / math.cos(0.6) + 0.1 * k),
                  (cx, ridge - (run / 2) * math.tan(0.6) + 0.16 * k, cz + s * run / 2),
                  0xeef4f9, pitch=-s * 0.6), 0.5)
    box((W + 0.9 * k, 0.22 * k, 0.36 * k), (cx, ridge + 0.3 * k, cz), 0x868ba1)
    box((0.7 * k, 1.9 * k, 0.7 * k), (cx - 1.1 * k, ridge - 0.2 * k, cz - 0.75 * k), 0x868ba1)
    snowy(box((0.82 * k, 0.14 * k, 0.82 * k), (cx - 1.1 * k, ridge + 0.8 * k, cz - 0.75 * k), 0xeef4f9))
    if smoke:
        marker('anim_smoke', (cx - 1.1 * k, ridge + 0.9 * k, cz - 0.75 * k))
    box((0.1 * k, 1.55 * k, 1.1 * k), (cx + W / 2 + 0.06 * k, 0.9 * k, cz - 0.55 * k), 0xfff6eb)
    box((0.1 * k, 1.35 * k, 0.85 * k), (cx + W / 2 + 0.12 * k, 0.82 * k, cz - 0.55 * k), 0x38383d)
    box((0.1 * k, 0.8 * k, 0.8 * k), (cx + W / 2 + 0.06 * k, 1.3 * k, cz + 0.95 * k), 0xfff6eb)
    box((0.1 * k, 0.6 * k, 0.6 * k), (cx + W / 2 + 0.12 * k, 1.3 * k, cz + 0.95 * k), 0xffc044)

@piece(1.0)
def log_cabin():
    # Flurry: a corner of the village below the lake at its real size beside
    # a car: a log cabin two and a half units across with its chimney smoking
    # (the first cabin on a track smokes), a smaller one beside it, the
    # woodpile under its lean-to, a villager.
    log_cabin_at(0.0, 0.0, 0.58, smoke=True)
    log_cabin_at(-0.6, 3.0, 0.42)
    woodpile(0.2, -2.2, 0.3)
    person(1.8, 0, -0.6, 0x3f7bd9, 0xcf534f, yaw=-0.4)
    join_still('cabins')

# ---- snow companions: small scenes that carry a track's story round its lap ----

@piece(1.0)
def ski_rack():
    # Powder: a ski school's meeting point by the piste, at its real size: its
    # hut, skis and poles racked along a rail (the skis under half a unit), a
    # trail sign, an instructor and two pupils waiting.
    cabin_hut(1.4, 0.8, 1.1, (-0.9, 0, 0.0), 0xcf534f, 0xeef4f9)
    for z in (-0.55, 0.55):
        box((0.06, 0.34, 0.06), (0.4, 0.17, z + 0.4), 0x9a7b55)
    box((0.06, 0.06, 1.2), (0.4, 0.31, 0.4), 0x9a7b55)
    for k, c in enumerate((0xff5040, 0x339cf2, 0x22c46e, 0xffc044)):
        z = -0.05 + k * 0.28
        for e in (-0.035, 0.035):
            box((0.04 + 0.02, 0.44, 0.06), (0.46, 0.22, z + e), c, roll=-0.18)
    box((0.08, 0.9, 0.08), (0.7, 0.45, -0.9), 0x555b66)               # the trail sign
    box((0.06, 0.26, 0.4), (0.74, 0.78, -0.9), 0x339cf2)
    box((0.07, 0.1, 0.24), (0.77, 0.78, -0.9), 0xfff6eb)
    person(1.0, 0, -0.2, 0xcf534f, 0xfff6eb, yaw=math.pi)
    person(0.6, 0, -0.45, 0x61cb8b, 0xffc044, yaw=0.0)
    person(0.55, 0, 0.05, 0xa878e8, 0x3f7bd9, yaw=-0.2)
    snow_heap((-0.4, 0, 1.3), 0.5, yaw=0.6)
    join_still('school')

def snowman(at, k=1.0, hat=False):
    """Three blocks of snow, coal eyes and buttons, a carrot facing +X, stick
    arms, a scarf: built the way the cars are, in chunky blocks, `k` sizing
    all of it (0.15: a real snowman, half a unit tall)."""
    x, y, z = at
    snowy(box((1.4 * k, 1.2 * k, 1.4 * k), (x, y + 0.6 * k, z), 0xf3f7fb, yaw=0.2), 0.5)
    snowy(box((1.05 * k, 0.9 * k, 1.05 * k), (x, y + 1.65 * k, z), 0xf3f7fb, yaw=-0.1), 0.5)
    snowy(box((0.8 * k, 0.75 * k, 0.8 * k), (x, y + 2.5 * k, z), 0xf3f7fb), 0.5)
    box((1.15 * k, 0.2 * k, 1.15 * k), (x, y + 2.12 * k, z), 0xff5040)
    box((0.45 * k, 0.16 * k, 0.16 * k), (x + 0.6 * k, y + 2.45 * k, z), 0xff7e44)
    for s2 in (-1, 1):
        box((0.14 * k, 0.14 * k, 1.0 * k), (x, y + 1.85 * k, z + s2 * 0.95 * k), 0x7a5a3a, pitch=s2 * 0.45)
    if hat:
        box((0.95 * k, 0.1 * k, 0.95 * k), (x, y + 2.92 * k, z), 0x2a2735)
        box((0.6 * k, 0.55 * k, 0.6 * k), (x, y + 3.25 * k, z), 0x2a2735)

def penguin(x, y, z, k=0.46, yaw=0.0, flippers=True):
    """A penguin standing at (x, y, z), beak to +X turned by `yaw`, `k` tall:
    a penguin beside a car is under half a unit. Feet, a dark body with its
    white front, the head and beak, the flippers. A live one is joined into
    one moving part by its caller."""
    u = k / 0.47
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s2, y + dy, z - dx * s2 + dz * c)
    box((0.18 * u, 0.06, 0.16 * u), at(0.03 * u, 0.03, 0), 0xff7e44, yaw=yaw)            # feet
    box((0.22 * u, 0.29 * u, 0.2 * u), at(0, 0.2 * u, 0), 0x2a2735, yaw=yaw)             # body
    box((0.06, 0.23 * u, 0.16 * u), at(0.1 * u, 0.19 * u, 0), 0xfff6eb, yaw=yaw)         # white front
    box((0.16 * u, 0.13 * u, 0.15 * u), at(0.01 * u, 0.405 * u, 0), 0x2a2735, yaw=yaw)   # head
    box((0.08 * u, 0.06, 0.06), at(0.11 * u, 0.39 * u, 0), 0xff7e44, yaw=yaw)            # beak
    if flippers:
        for sd in (-1, 1):
            box((0.12 * u, 0.18 * u, 0.06), at(0, 0.22 * u, sd * 0.12 * u), 0x2a2735, yaw=yaw, pitch=sd * 0.25)

def slider_penguin(x, y, z, k=0.45):
    """A penguin on its belly toward +X, `k` long, the pivot under the middle
    of its belly: the body flat, the head up to see where it is going (the
    beak and the white face say "penguin" from above), flippers out."""
    u = k / 0.45
    box((0.36 * u, 0.13 * u, 0.2 * u), (x, y + 0.075 * u, z), 0x2a2735)                  # body
    box((0.26 * u, 0.06, 0.17 * u), (x + 0.02 * u, y + 0.035, z), 0xfff6eb)               # belly
    box((0.15 * u, 0.14 * u, 0.15 * u), (x + 0.2 * u, y + 0.17 * u, z), 0x2a2735)         # head, up
    box((0.06, 0.1 * u, 0.12 * u), (x + 0.28 * u, y + 0.16 * u, z), 0xfff6eb)             # face
    box((0.08 * u, 0.06, 0.06), (x + 0.32 * u, y + 0.15 * u, z), 0xff7e44)                # beak
    for sd in (-1, 1):
        box((0.14 * u, 0.06, 0.1 * u), (x - 0.02 * u, y + 0.07 * u, z + sd * 0.15 * u), 0x2a2735)  # flipper out
    box((0.08 * u, 0.06, 0.12 * u), (x - 0.21 * u, y + 0.03, z), 0xff7e44)                # feet behind

# The standing penguins' life (set_motion.h): rock on their feet out of step,
# turn to watch a car coming (radii in world units), a little hop as one
# passes close.
PENGUIN = 'anim_waddle+watch:r=30+hop:r=14:h=0.12#%d'

def live_penguin(n, x, y, z, k, yaw):
    with animated(PENGUIN % n, (x, y, z), yaw):
        penguin(x, y, z, k, yaw)

def stood_penguin(x, z, k, yaw):
    """A penguin of the crowd, standing still: three blocks (the dark body
    with its head, the white front, the beak), which is what reads of one
    among many."""
    u = k / 0.47
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy):
        return (x + dx * c, dy, z - dx * s2)
    box((0.22 * u, 0.44 * u, 0.2 * u), at(0, 0.22 * u), 0x2a2735, yaw=yaw)
    box((0.06, 0.26 * u, 0.16 * u), at(0.1 * u, 0.17 * u), 0xfff6eb, yaw=yaw)
    box((0.08 * u, 0.06, 0.06), at(0.13 * u, 0.36 * u), 0xff7e44, yaw=yaw)

@piece(1.0)
def penguin_group():
    # Glacier: a colony of penguins out on the snow by the ice, standing on
    # the snow itself at their own size beside a car (under half a unit tall):
    # a crowd of a couple of dozen, a few lying on their bellies and a chick
    # or two among them, most facing +X; two at the front are alive where
    # they stand (they rock on their feet, turn to watch a car coming and hop
    # as one passes close), and a pair wanders a loop round the colony's
    # edge, one behind the other (anim_path facing its way, a bob for the
    # step). Each placement's yaw turns +X to the racer where the lap reads
    # it best (score:landmarks' `face`).
    for i in range(24):
        # a sunflower spread over an oval, so the crowd is even without a grid
        r, a = math.sqrt((i + 0.5) / 24), i * 2.39996
        x, z = 2.6 * r * math.cos(a), 1.7 * r * math.sin(a)
        if x > 0.9 and abs(z) < 0.9:
            continue                                               # room for the live ones in front
        h = math.sin(i * 12.9898) * 0.5 + 0.5
        yaw = (h - 0.5) * 1.6 + 0.6 * math.sin(i * 3.1)
        if i % 9 == 4:
            slider_penguin(x, 0, z, 0.4)                           # lying on its belly
        else:
            stood_penguin(x, z, 0.34 if i % 7 == 3 else 0.42 + 0.06 * h, yaw)
    live_penguin(1, 1.4, 0, 0.35, 0.46, 0.0)
    live_penguin(2, 1.2, 0, -0.45, 0.44, 0.3)
    N = 14
    pts = [(math.cos(a) * 3.3, 0.0, math.sin(a) * 2.3) for a in (j / N * 2 * math.pi for j in range(N))]
    for j, p in enumerate(pts):
        marker('path_walk_%d' % j, p)
    for k in range(2):
        at = pts[k]
        with animated('anim_path:c=walk:p=36:o=%.3f:f=1+bob:h=0.03:p=0.42#%d' % (k * 0.06, k), at):
            penguin(at[0], 0, at[2], 0.44, 0.0)
    snow_heap((-2.8, 0, 1.6), 0.5, yaw=0.5)

@piece(1.0)
def penguin_chute():
    # Glacier: the colony's toboggan run, at the penguins' own size. A drift
    # of snow banked up by the shore, rising away from the road (-X), its
    # face worn into a slide; penguins come over its crest, belly-slide down
    # toward the road (+X) and shoot into a hole of open water in the ice at
    # its foot. Under the ice they swim back behind the crest (the path's
    # hidden half runs under the drift and the ice), so a split cell sees
    # them go in and come out, never jump. More stand at the water's edge and
    # on top to watch.
    H = mound(2.0, -2.6, 0.0, 3.4, 5.6, 3.4, color=0xeef4f9, sink=0.3, shape=1.3)
    disc(1.5, (4.3, 0.0, 0.0), 0xd0e8ff, segs=20, h=0.04)            # the ice round the hole
    disc(0.95, (4.3, 0.01, 0.0), 0x6794d9, segs=16, h=0.04)          # open water
    xs = [-2.6 + 0.6 * i for i in range(10)]                           # down the face, on the drift
    pts = [(-3.9, H(-3.9, 0.0) - 0.45, 0.0)] + [(x, max(H(x, 0.0), 0.0) + 0.01, 0.0) for x in xs]
    pts += [(3.6, 0.03, 0.0), (4.2, 0.0, 0.0), (4.4, -0.6, 0.0), (4.0, -1.4, 0.0), (-3.9, -1.4, 0.0)]
    for k, pt in enumerate(pts):
        marker('path_chute_%d' % k, pt)
    for n in range(3):                            # spread round the loop; the renderer moves them
        x = -1.5 + 1.5 * n
        with animated('anim_path:c=chute:p=9:o=%.3f#%d' % (n / 3, n), (x, H(x, 0.0) + 0.01, 0.0)):
            slider_penguin(x, H(x, 0.0) + 0.01, 0.0, 0.42)
    penguin(5.0, 0.04, 1.0, 0.46, -0.4, flippers=False)
    penguin(4.6, 0.04, -1.2, 0.42, 0.5, flippers=False)
    penguin(5.4, 0.04, -0.4, 0.34, 0.1, flippers=False)
    penguin(-2.4, H(-2.4, 0.9) - 0.03, 0.9, 0.44, 0.0, flippers=False)

@piece(1.0)
def expedition_camp():
    # Glacier: a climbers' camp at its real size beside a car: three ridge
    # tents (under a unit long) behind a curved wall of snow blocks against
    # the wind, a long sled loaded with kit, rucksacks, a flag on its pole
    # streaming, two climbers.
    def tent(x, z, color):
        k = 0.27
        for s2 in (-1, 1):
            box((3.2 * k, 0.06, 1.9 * k), (x, 0.72 * k, z + s2 * 0.66 * k), color, pitch=-s2 * 0.86)
        box((3.4 * k, 0.06, 0.06), (x, 1.46 * k, z), 0x2a2735)
        for s in (-1, 1):
            prism([(z + 1.28 * k, 0.02), (z - 1.28 * k, 0.02), (z, 1.42 * k)], x + s * 1.52 * k, 0.06, color)
        prism([(z + 0.5 * k, 0.02), (z - 0.5 * k, 0.02), (z, 0.95 * k)], x + 1.6 * k, 0.06, 0x2a2735)
    tent(0.0, 0.0, 0xff7e44)
    tent(-0.3, 0.9, 0xcf534f)
    tent(0.2, -0.95, 0xffc044)
    for k in range(6):                                              # the wind wall, round the back
        a = -1.1 + k * 0.44
        snowy(box((0.18, 0.26, 0.5), (-0.75 - 0.6 * math.cos(a) + 0.6, 0.13, 1.25 * math.sin(a)), 0xf3f7fb,
                  yaw=a), 0.4)
    sled(0.9, 0, 0.9, 0.3, 0x9a7b55, L=0.7)
    box((0.22, 0.12, 0.3), (0.92, 0.2, 0.9), 0x3f7bd9, yaw=0.3)     # its load
    for (x, z, c) in ((0.75, -0.35, 0xcf534f), (0.85, -0.15, 0x61cb8b)):
        box((0.12, 0.18, 0.1), (x, 0.09, z), c, yaw=0.3)
    person(1.1, 0, -0.5, 0xcf534f, 0x38383d, yaw=0.5)
    person(1.25, 0, 0.25, 0x3f7bd9, 0xffc044, yaw=-0.6)
    box((0.07, 1.1, 0.07), (0.6, 0.55, -1.5), 0xfff6eb)
    with animated('anim_sway:a=z:d=24:p=1.9#1', (0.6, 1.1, -1.5)):
        box((0.36, 0.22, 0.05), (0.8, 0.98, -1.5), 0xff5040)
    join_still('camp')

@piece(1.0)
def avalanche_fence():
    # Avalanche: the defences on the mountainside the road runs under, at
    # their real size beside a car: rows of snow rakes across the slope above
    # the verge (a unit tall, leaning into the hill, each one a rail of
    # upright slats on posts braced from below), stepping up the face one
    # above the other so the lines read across the white from the road, and
    # at the foot a run of slatted snow fence with the drift it caught. The
    # mountainside is the track's terrain (SET_GROUND).
    H = set_ground('avalanche-fence')
    for x, z, k in ((-14.0, -12.6, 1.8), (-19.6, 11.2, 1.9), (-30.8, -19.6, 1.8)):
        pine((x, H(x, z) - 0.6, z), k)
    # The rakes and the fence are draped: built from y = 0 as if on the plain,
    # each laid on the slope as the renderer draws it (its 9 u grid's chords
    # stray a unit and more off the curve at the foot), so none floats or sinks.
    def rake(x, z0, z1):
        n = max(2, int(round((z1 - z0) / 2.0)))
        zs = [z0 + (z1 - z0) * i / n for i in range(n + 1)]
        for z in zs:                                                # posts, leaning into the hill
            box((0.1, 1.3, 0.1), (x, 0.35, z), 0x6e4a32, roll=0.35)
        for za, zb in zip(zs[:-1], zs[1:]):                         # the slatted boards between them
            box((0.06, 0.7, zb - za), (x - 0.22, 0.55, (za + zb) / 2), 0x8a6a46, roll=0.35)
    def defences():
        for (x, half) in ((-6.0, 6.0), (-10.5, 7.5), (-15.0, 8.5), (-19.5, 8.0)):
            rake(x, -half, half)
        # the snow fence at the foot, its slats upright, the drift along its back
        L = 7.0
        for i in range(5):
            z = -L / 2 + i * L / 4
            box((0.1, 1.1, 0.1), (0.1, 0.4, z), 0x6e4a32)
        for i in range(4):
            z = -L / 2 + (i + 0.5) * L / 4
            box((0.06, 0.75, L / 4 - 0.12), (0.18, 0.5, z), 0xb06041 if i % 2 else 0x8a6a46)
        snowy(box((0.6, 0.35, L - 0.4), (-0.25, 0.07, 0), 0xf3f7fb))
    draped('rakes', defences)

@piece(1.0)
def warning_sign():
    # Avalanche: an avalanche warning under the slope it warns of (the slope
    # is the track's terrain, SET_GROUND), at its real size beside a car: a
    # yellow diamond with the slope and its tumbling snow on it, on a post
    # beside a red and white marker pole; rocks that came down lie at its
    # foot and up the face, a pine.
    H = set_ground('warning-sign')
    for x, z, k in ((-11.2, 11.2, 1.8), (-14.0, -8.0, 1.7)):
        pine((x, H(x, z) - 0.6, z), k)
    def sign():
        # at the slope's foot, where the grid's chords stray furthest from the
        # curve: draped, the sign and its rocks stand on the snow as drawn
        for x, z, k in ((-2.4, -3.4, 0.6), (-3.4, 2.2, 0.8), (-1.6, 4.4, 0.45), (-5.0, -0.6, 0.6),
                        (-8.0, -4.0, 0.7), (-11.0, 3.0, 0.8), (-6.5, 6.5, 0.5)):
            rock((x, -0.35 * k, z), k, yaw=x * z)
        box((0.08, 1.2, 0.08), (0, 0.4, 0), 0x555b66)
        box((0.06, 0.5, 0.5), (0.04, 0.85, 0), 0x2a2735, pitch=math.pi / 4)
        box((0.06, 0.42, 0.42), (0.07, 0.85, 0), 0xffc044, pitch=math.pi / 4)
        prism([(0.14, 0.76), (-0.14, 0.76), (-0.03, 0.94)], 0.11, 0.03, 0x2a2735)
        box((0.08, 0.2, 0.08), (0.0, 0.0, 0.6), 0xfff6eb)
        for k in range(5):
            box((0.08, 0.22, 0.08), (0.0, 0.11 + k * 0.22, 0.6), 0xff5040 if k % 2 == 0 else 0xfff6eb)
        snow_heap((-0.5, -0.1, -0.5), 0.5, yaw=0.3)
    draped('sign', sign)

# ====================================================================================
# BACKYARD
# ====================================================================================

def strut(a, b, t, color):
    """A square bar `t` across from glTF point a to b: a ladder rail, a fork."""
    dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
    return box((t, t, math.sqrt(dx * dx + dy * dy + dz * dz)), mid, color,
               yaw=math.atan2(dx, dz), pitch=math.atan2(dy, math.hypot(dx, dz)))

# The backyard is the tiny world at its own scale, the scale the trees and the
# cars already set: a car is a car (0.9 long), so a cottage is two of it, a
# swing comes up to its roof and a church spire stands over the trees. Every
# piece here is authored in METRES (a car 3.6 long, the road 10 wide) and
# grown REAL at export, so the bars, chamfers and plates of the cars' grammar
# keep their proportions at the size of real things. Nothing everyday is
# giant: what is big is land, water and many real things together.
REAL = 0.25

def local(cx, cz, yaw):
    """Points in a frame at (cx, cz) turned by `yaw` (box()'s sense)."""
    c, s = math.cos(yaw), math.sin(yaw)
    return lambda dx, dy, dz: (cx + dx * c + dz * s, dy, cz - dx * s + dz * c)

SKIN = 0xf2bf99
HAIR = (0x7a5a3a, 0x2a2735, 0xffc044, 0xb06041)

def person(at, yaw, shirt, k=1.0, hair=0, legs=0x4f5260, sit=False, arm=0.0):
    """Someone facing +X turned by `yaw`, 1.9 tall at k 1 (a child is about
    0.7): blocks, the cars' way, about twice life size across so they read.
    Sitting, the seat is at `at` and the legs reach forward off it. `arm`
    lifts the arms forward (radians), to hold a rope or a ribbon."""
    L = local(at[0], at[2], yaw)
    y = at[1]
    if sit:
        box((0.6 * k, 0.24 * k, 0.44 * k), L(0.2 * k, y + 0.12 * k, 0), legs, yaw=yaw)
        box((0.22 * k, 0.5 * k, 0.44 * k), L(0.42 * k, y - 0.12 * k, 0), legs, yaw=yaw)
        b = y + 0.22 * k
    else:
        box((0.32 * k, 0.86 * k, 0.44 * k), L(0, y + 0.43 * k, 0), legs, yaw=yaw)
        b = y + 0.84 * k
    box((0.4 * k, 0.64 * k, 0.54 * k), L(0, b + 0.32 * k, 0), shirt, yaw=yaw)
    for s in (-1, 1):
        box((0.2 * k, 0.56 * k, 0.17 * k), L(0.05 * k + 0.28 * k * math.sin(arm), b + 0.58 * k - 0.28 * k * math.cos(arm), s * 0.35 * k),
            shirt, yaw=yaw, roll=-arm)
    box((0.4 * k, 0.4 * k, 0.38 * k), L(0, b + 0.84 * k, 0), SKIN, yaw=yaw)
    box((0.44 * k, 0.14 * k, 0.42 * k), L(-0.03 * k, b + 1.08 * k, 0), HAIR[hair % 4], yaw=yaw)

def gable_roof(F, yaw, y0, D, L, H, roof, wall, pitch_deg=45.0, t=0.4, over=0.5):
    """A pitched roof over walls D across (X) and L along (Z), H tall, its
    ridge along Z: the gable ends a square beam turned along the ridge (its
    upper half stands over the walls as the end walls' triangles), two slabs
    and a ridge cap. Returns the ridge height."""
    a = math.radians(pitch_deg)
    rise = D / 2 * math.tan(a)
    g = D / math.sqrt(2)
    box((g, g, L - 0.04), F(0, y0 + H, 0), wall, yaw=yaw, roll=math.pi / 4)
    if pitch_deg != 45.0:   # the beam's triangle only fits 45: a steeper roof stands a wall block under it
        box((D * 0.7, rise - D / 2, L - 0.04), F(0, y0 + H + (rise - D / 2) / 2 + D / 4, 0), wall, yaw=yaw)
    w = (D / 2 + over) / math.cos(a)
    for k in (-1, 1):
        cx = k * (w / 2 * math.cos(a) + math.sin(a) * t / 2)
        cy = y0 + H + rise - w / 2 * math.sin(a) + math.cos(a) * t / 2
        box((w, t, L + 2 * over * 0.8), F(cx, cy, 0), roof, yaw=yaw, roll=k * a)
    box((t * 1.3, t * 1.3, L + 2 * over * 0.8 + 0.1), F(0, y0 + H + rise + t * 0.55, 0), roof, yaw=yaw)
    return y0 + H + rise

def window(F, yaw, x, y, z, w=1.3, h=1.3, glass='slate'):
    """A window on a +X wall at x: a white frame standing proud, the glass in it."""
    box((0.14, h + 0.3, w + 0.3), F(x + 0.05, y, z), 'white', yaw=yaw)
    box((0.14, h, w), F(x + 0.11, y, z), glass, yaw=yaw)

def cottage(at, yaw, wall, roof, door=0x339cf2, L=8.0, D=5.5, H=4.2, smoke=False, chimney=1):
    """A cottage, its front on +X turned by `yaw`: a steep pitched roof (ridge
    along its length, Z), a chimney at one gable, a door and two windows in
    white frames standing proud as a car's lamps do."""
    F = local(at[0], at[2], yaw)
    y0 = at[1]
    box((D, H, L), F(0, y0 + H / 2, 0), wall, yaw=yaw)
    ridge = gable_roof(F, yaw, y0, D, L, H, roof, wall)
    cz = chimney * (L / 2 - 1.1)
    box((1.1, 2.6, 1.1), F(-0.6, ridge - 0.6, cz), 0xb06041, yaw=yaw)
    if smoke:
        marker('anim_smoke', F(-0.6, ridge + 0.8, cz))
    box((0.14, 2.4, 1.5), F(D / 2 + 0.05, 1.2 + y0, 0), 'white', yaw=yaw)
    box((0.14, 2.1, 1.1), F(D / 2 + 0.11, 1.05 + y0, 0), door, yaw=yaw)
    for s in (-1, 1):
        window(F, yaw, D / 2, y0 + H * 0.55, s * L * 0.3)

def washing(at, yaw, n, seed):
    """A garden washing line along Z on two T-posts, chest high, n things
    pegged on it swaying together in the wind about the line."""
    F = local(at[0], at[2], yaw)
    y0 = at[1]
    LH = 2.2
    span = n * 1.25 + 1.0
    for s in (-1, 1):
        box((0.2, LH + 0.15, 0.2), F(0, y0 + (LH + 0.15) / 2, s * span / 2), 0x9a7b55, yaw=yaw)
        box((0.9, 0.16, 0.16), F(0, y0 + LH + 0.07, s * span / 2), 0x9a7b55, yaw=yaw)
    strut(F(0.35, y0 + LH, -span / 2), F(0.35, y0 + LH, span / 2), 0.07, 'white')
    KIND = [(0xff5040, 0.9, 0.8), (0xf8f8fb, 1.0, 1.1), (0x339cf2, 0.7, 1.0), (0xffc044, 0.9, 0.7),
            (0x22c46e, 0.8, 0.9), (0xa259e6, 0.9, 0.8)]
    with animated('anim_sway:a=z:d=20:p=%.1f#%d' % (2.0 + 0.3 * (seed % 3), seed), F(0.35, y0 + LH, 0), yaw=yaw):
        for i in range(n):
            col, w, h = KIND[(i + seed * 2) % len(KIND)]
            z = -span / 2 + 0.75 + i * 1.25
            box((0.08, h, w), F(0.35, y0 + LH - h / 2 + 0.02, z), col, yaw=yaw)

def hedge(F, yaw, y0, a, b, h=1.1, t=0.9):
    """A clipped garden hedge from local (x, z) a to b."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dz)
    # along the hedge in the frame: its yaw there is atan2(dx, dz)
    box((t, h, ln + t), F((a[0] + b[0]) / 2, y0 + h / 2, (a[1] + b[1]) / 2), 0x4f9a48, yaw=yaw + math.atan2(dx, dz))

def round_tree(at, h=5.0, r=2.0, color=0x5f9f4a):
    """A small garden tree: a trunk and one faceted crown."""
    cyl(0.25 * r / 2, h * 0.5, at, 0x7a5a3a, segs=6)
    sphere(r, (at[0], at[1] + h - r, at[2]), color, subdiv=1)

def tent(at, yaw, color, L=2.4, W=1.8, H=1.3):
    """A ridge tent, its door end on +X: two pitched sheets, a back wall and
    an open, dark door."""
    F = local(at[0], at[2], yaw)
    y0 = at[1]
    a = math.atan2(H, W / 2)
    w = math.hypot(W / 2, H)
    for k in (-1, 1):
        box((L, 0.1, w), F(0, y0 + H / 2, k * W / 4), color, yaw=yaw, pitch=-k * a)
    box((0.2, H * 0.85, 0.5), F(L / 2 - 0.05, y0 + H * 0.42, 0), 0x2a2735, yaw=yaw)

def kennel(at, yaw):
    """A dog's kennel, its door on +X, and the dog sitting at it."""
    F = local(at[0], at[2], yaw)
    y0 = at[1]
    box((1.1, 0.8, 1.0), F(0, y0 + 0.4, 0), 0xd94f3d, yaw=yaw)
    gable_roof(F, yaw, y0, 1.1, 1.0, 0.8, 0x7a5a3a, 0xd94f3d, t=0.12, over=0.12)
    box((0.12, 0.5, 0.4), F(0.56, y0 + 0.27, 0), 0x2a2735, yaw=yaw)
    # the dog: body, sitting haunch, head, ears, tail
    box((0.7, 0.42, 0.34), F(1.0, y0 + 0.3, 0.1), 0xb06041, yaw=yaw)
    box((0.36, 0.36, 0.3), F(1.4, y0 + 0.62, 0.1), 0xb06041, yaw=yaw)
    box((0.2, 0.16, 0.16), F(1.62, y0 + 0.56, 0.1), 0x2a2735, yaw=yaw)
    box((0.3, 0.14, 0.1), F(0.62, y0 + 0.5, 0.1), 0xb06041, yaw=yaw, roll=0.5)

# ---- RIBBON: the village -------------------------------------------------------------
# Ribbon is a village in the hills: cottages up the terraces either side of
# the circuit, each with its own washing out, the church with its spire over
# the green where the maypole's ribbons go round, and the windmill on the hill
# at the south end turning. The spire and the sails are the tall things, as
# they are in a real village; everything else is a cottage's size.

@piece(REAL)
def cottage_row():
    # Three cottages along a lane (their fronts +X, to the road), each with a
    # back garden hedged off from the next: washing out either side, the
    # vegetable bed in the middle one, a shed. One chimney smokes. They stand
    # on the bank the lane runs along (SET_GROUND), built flat on its top and
    # lifted onto it, a hand's breadth sunk so no garden corner stands proud
    # where the ground's grid rounds the bank's edge.
    s0 = set_ground('cottage-row')(0.0, 0.0) - 0.3
    WALL = (0xf8f8fb, 0xfde4c7, 0xf8f8fb)
    ROOF = (0xcf534f, 0xd9b054, 0x4f5260)
    DOOR = (0x339cf2, 0x22c46e, 0xff5040)
    for i, z in enumerate((-11.0, 0.0, 11.0)):
        x = (0.0, 0.8, -0.4)[i]
        cottage((x, 0, z), 0.0, WALL[i], ROOF[i], DOOR[i], smoke=(i == 1), chimney=(1, -1, 1)[i])
        if i != 1:
            washing((x - 8.5, 0, z), 0.0, 4 + i // 2, i)
    F = local(0, 0, 0)
    for z in (-16.5, -5.5, 5.5, 16.5):
        hedge(F, 0.0, 0.0, (-3.0, z), (-14.0, z))
    hedge(F, 0.0, 0.0, (-14.0, -16.5), (-14.0, 16.5))
    # the shed under its lean-to roof, the vegetable bed
    box((2.6, 2.2, 2.0), (-12.0, 1.1, -13.5), 0x9a7b55)
    box((3.0, 0.24, 2.4), (-12.0, 2.35, -13.5), 0x4f5260, roll=0.2)
    box((5.0, 0.3, 6.0), (-7.0, 0.15, 0.0), 0x7a5a3a)
    for k in range(2):
        box((0.6, 0.5, 5.4), (-8.0 + k * 2.0, 0.45, 0.0), 0x61cb8b)
    for o in bpy.context.scene.objects:          # onto the bank
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p) for n, (x, y, z), yaw, p in ANIMS]
    join_still('cottages')

@piece(REAL)
def village_church():
    # The church: nave along Z under a slate roof, the tower at its -Z end
    # carrying the spire (the tallest thing in the village, about six cars),
    # a porch on the road side (+X), the clock; yews and headstones in the
    # churchyard behind. On the green before it the maypole stands, children
    # dancing round it with its ribbons (the lot turns round the pole).
    STONE, SLATE = 0xfde4c7, 0x4f5260
    F = local(0, 0, 0)
    D, L, H = 8.0, 16.0, 6.5
    box((D, H, L), (0, H / 2, 0), STONE)
    gable_roof(F, 0.0, 0.0, D, L, H, SLATE, STONE, pitch_deg=45.0)
    TZ = -L / 2 - 2.6
    T = 5.6
    box((T, 14.0, T), (0, 7.0, TZ), STONE)
    for sx in (-1, 1):                                    # the tower's corner pinnacles
        for sz in (-1, 1):
            box((0.8, 1.4, 0.8), (sx * (T / 2 - 0.4), 14.7, TZ + sz * (T / 2 - 0.4)), STONE)
    cyl(2.5, 11.5, (0, 14.0, TZ), SLATE, r2=0.12, segs=8)             # the spire
    cyl(1.3, 0.2, (T / 2, 10.4, TZ), 'white', segs=12, axis='across')  # the clock
    box((0.12, 0.9, 0.16), (T / 2 + 0.22, 10.7, TZ), 0x2a2735)
    box((0.12, 0.16, 0.7), (T / 2 + 0.22, 10.4, TZ + 0.3), 0x2a2735)
    box((0.14, 3.0, 1.6), (T / 2 + 0.06, 1.5, TZ), 0x7a5a3a)              # the tower door
    for z in (-5.0, -1.0, 5.0):                                           # tall windows
        window(F, 0.0, D / 2, 3.6, z, w=1.0, h=2.8, glass=0x6794d9)
    # the porch on the road side
    PF = local(D / 2 + 1.5, 2.6, 0.0)
    box((3.0, 3.0, 3.0), PF(0, 1.5, 0), STONE)
    box((0.14, 2.3, 1.3), PF(1.55, 1.15, 0), 0x7a5a3a)
    box((3.4, 0.4, 3.8), PF(-0.1, 3.2, 0), SLATE)
    # the churchyard behind: two yews, headstones
    for z in (-6.0, 6.0):
        cyl(0.4, 1.4, (-D / 2 - 4.5, 0, z), 0x7a5a3a, segs=6)
        cyl(2.4, 6.0, (-D / 2 - 4.5, 1.2, z), 0x3f7a4a, r2=0.5, segs=8)
    for k in range(4):
        box((0.25, 1.0, 0.7), (-D / 2 - 2.0 - (k % 2) * 2.2, 0.5, -2.0 + (k // 2) * 3.0), 'grey')
    # the green: a bench each side, the maypole
    MX = D / 2 + 9.5
    for z in (-6.0, 6.0):
        bench((MX + 3.5, 0, z), yaw=-math.pi / 2)
    box((0.35, 9.0, 0.35), (MX, 4.5, 0), 'white')
    cyl(0.5, 0.5, (MX, 9.0, 0), 0xff5040, segs=8)
    COLS = (0xff5040, 0x339cf2, 0xffc044, 0x22c46e, 0xa259e6, 0xf8f8fb, 0x339cf2, 0xff5040)
    with animated('anim_spin:w=0.55', (MX, 0, 0)):
        cyl(0.75, 0.5, (MX, 8.2, 0), 0xffc044, segs=8)
        for k in range(6):
            a = k * 2 * math.pi / 6
            r = 4.2
            px, pz = MX + r * math.cos(a), r * math.sin(a)
            # each child runs round the pole (faces along the circle), the
            # ribbon in the hand nearest the pole
            person((px, 0, pz), -a - math.pi / 2, COLS[k], k=0.7, hair=k, arm=0.9)
            hx, hz = MX + (r - 0.35) * math.cos(a), (r - 0.35) * math.sin(a)
            strut((MX + 0.6 * math.cos(a), 8.3, 0.6 * math.sin(a)), (hx, 1.35, hz), 0.12, COLS[(k + 3) % 8])
    join_still('church')

@piece(REAL)
def windmill():
    # The village's tower mill: a whitewashed tower tapering to a red cap,
    # its stage round it, door and windows on the road side (+X), and four
    # sails turning about the windshaft, face on to the road. Real size:
    # about five cars to the cap, the sails sweeping to seven.
    H = 15.0
    cyl(4.2, H, (0, 0, 0), 'white', r2=3.0, segs=8, yaw=math.pi / 8)   # a face, not an edge, to the road
    cyl(3.4, 2.8, (0, H, 0), 0xcf534f, r2=1.6, segs=8)
    box((1.6, 0.8, 4.4), (0.4, H + 1.2, 0), 0xcf534f)
    cyl(4.9, 0.35, (0, 3.4, 0), 0x9a7b55, segs=8, yaw=math.pi / 8)      # the stage, under the sails' sweep
    box((0.3, 2.6, 1.6), (3.92, 1.3, 0), 0x7a5a3a)                       # the door
    for y in (8.5, 12.0):
        r = (4.2 - 1.2 * y / H) * math.cos(math.pi / 8)
        window(local(0, 0, 0), 0.0, r - 0.1, y, 0, w=0.9, h=1.1)
    for k in (-1, 1):                                                    # sacks by the door
        box((0.8, 0.9, 0.7), (5.0, 0.45, k * 1.6), 0xfde4c7)
    HY, HX = H + 1.3, 3.2
    with animated('anim_spin:a=x:w=0.7', (HX + 0.9, HY, 0)):
        cyl(0.7, 2.6, (HX - 1.0, HY, 0), 0x2a2735, segs=8, axis='across')
        for k in range(4):
            a = k * math.pi / 2 + math.pi / 4
            dy, dz = math.sin(a), math.cos(a)
            strut((HX + 0.9, HY, 0), (HX + 0.9, HY + dy * 11.5, dz * 11.5), 0.4, 0x7a5a3a)
            # the sail on the leading side of its stock: a white board, its laths
            py, pz = math.cos(a), -math.sin(a)
            cy, cz = HY + dy * 7.2 + py * 1.15, dz * 7.2 + pz * 1.15
            box((0.12, 2.0, 8.4), (HX + 1.05, cy, cz), 'white', pitch=a)
            for j in (-1, 1):
                box((0.14, 0.16, 8.4), (HX + 1.12, cy + py * j * 0.9, cz + pz * j * 0.9), 0x9a7b55, pitch=a)
    join_still('mill')

# ---- PRETZEL: the treehouse -----------------------------------------------------------
# Pretzel's old oak on its hill, a tree about six cars tall, with the
# children's den in it: a platform round the trunk on legs, a red hut on it
# a car wide, a ladder, a rope ladder, a flag, the tyre swinging from a bough
# with a child in it. At its foot their tent, the trampoline with a child
# bouncing, and the dog at its kennel. It grew on its knoll (SET_GROUND): built
# from the summit, then lifted onto it, the trunk sunk in and everything at its
# foot standing on the slope.

@piece(REAL)
def treehouse():
    H = set_ground('treehouse')
    s0 = H(0.0, 0.0)
    G = lambda x, z: H(x, z) - s0
    BARK, WOOD = 0x7a5a3a, 0xb08a5a
    cyl(1.4, 15.0, (0, -2.0, 0), BARK, r2=0.9, segs=10)
    for a, r, h in ((1.6, 0.6, 5.0), (3.4, 0.55, 4.6), (5.0, 0.5, 4.4)):  # boughs away from the hut
        o = cyl(r, h, (0, 9.0, 0), BARK, r2=0.25, segs=7, smooth=False)
        tilted(o, math.cos(a) * 0.9, math.sin(a) * 0.9)
    for c, r in (((0, 18.0, 0), 6.2), ((-4.8, 16.0, 3.0), 4.6), ((4.2, 16.6, -3.4), 4.4),
                 ((1.0, 21.2, 2.4), 4.2), ((-2.0, 19.5, -3.6), 3.8)):
        sphere(r, c, 0x5f9f4a if r > 4.5 else 0x6cae55, subdiv=1)
    # the platform on four legs, its rails
    PY = 4.4
    box((7.6, 0.35, 6.6), (0.6, PY, 0), WOOD)
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = 0.6 + sx * 3.6, sz * 3.1
            box((0.3, PY - G(x, z) + 0.2, 0.3), (x, (PY + G(x, z)) / 2, z), WOOD)
    for sz in (-1, 1):
        box((7.6, 0.18, 0.18), (0.6, PY + 1.0, sz * 3.2), WOOD)
        for x in (-3.0, -1.0, 1.0):
            box((0.16, 1.0, 0.16), (x, PY + 0.5, sz * 3.2), WOOD)
    box((0.18, 0.18, 6.6), (-3.1, PY + 1.0, 0), WOOD)
    # the hut on the platform's road side (+X), clear of the trunk
    HF = local(2.9, 0.0, 0.0)
    box((3.0, 2.5, 4.0), HF(0, PY + 1.42, 0), 0xd94f3d)
    gable_roof(HF, 0.0, PY + 0.17, 3.0, 4.0, 2.5, 0x7a5a3a, 0xd94f3d, t=0.25, over=0.3)
    box((0.12, 1.7, 0.9), HF(1.56, PY + 1.05, -0.8), 0x5a3a2a)
    window(HF, 0.0, 1.5, PY + 1.6, 0.9, w=0.8, h=0.7, glass=0x8ecae6)
    flagpole((-3.1, PY + 1.0, -3.1), 2.6, 0x22c46e, w=1.4, fh=0.8, pole=WOOD, wave='anim_sway:a=z:d=22:p=1.5')
    # the ladder up the front, its foot out on the lawn
    for s in (-1, 1):
        strut((3.0 + s * 0.4, G(3.0, 5.4) - 0.1, 5.4), (3.0 + s * 0.4, PY, 3.3), 0.16, WOOD)
    for i in range(6):
        t = (i + 0.8) / 6.6
        y0 = G(3.0, 5.4)
        box((0.9, 0.12, 0.14), (3.0, y0 + (PY - y0) * t, 5.4 - 2.1 * t), WOOD)
    # the rope ladder off the back
    for s in (-1, 1):
        strut((-2.6, PY, s * 0.35 - 1.0), (-2.6, G(-2.6, -1.0) + 0.3, s * 0.35 - 1.0), 0.07, 0x9a7b55)
    for i in range(5):
        box((0.12, 0.1, 0.8), (-2.6, G(-2.6, -1.0) + 0.6 + i * 0.75, -1.0), 0x9a7b55)
    # the tyre swing from its own bough, a child sitting in it
    BX, BZ = -6.0, -5.0
    strut((0.0, 9.6, -0.2), (BX, 10.6, BZ), 0.7, BARK)
    gy = G(BX + 0.3, BZ + 0.3)
    with animated('anim_sway:a=x:d=24:p=2.8', (BX + 0.3, 10.3, BZ + 0.3)):
        strut((BX + 0.3, 10.4, BZ + 0.3), (BX + 0.3, gy + 1.3, BZ + 0.3), 0.08, 0x9a7b55)
        torus(0.55, 0.2, (BX + 0.3, gy + 0.95, BZ + 0.3), 0x2a2735, segs=12, axis='across')
        person((BX + 0.3, gy + 0.85, BZ + 0.3), 0.0, 0xffc044, k=0.65, hair=1, sit=True)
    # a child up on the platform, looking out
    person((1.6, PY + 0.17, -2.6), 0.4, 0x339cf2, k=0.7, hair=0)
    # the den at its foot: the tent, the trampoline with a child bouncing, the dog
    tent((7.5, G(7.5, -5.0), -5.0), 0.5, 0xffc044)
    TX, TZ = -1.0, 9.5
    ty = G(TX, TZ)
    cyl(1.9, 0.12, (TX, ty + 0.8, TZ), 0x2a2735, segs=12)
    torus(1.9, 0.12, (TX, ty + 0.9, TZ), 0x339cf2, segs=12)
    for k in range(4):
        a = k * math.pi / 2 + 0.4
        box((0.16, 1.9, 0.16), (TX + 1.8 * math.cos(a), ty - 0.05, TZ + 1.8 * math.sin(a)), 0x555b66)   # legs bedded in the slope
    with animated('anim_bob:h=1.1:p=1.0', (TX, ty + 0.92, TZ)):
        person((TX, ty + 0.92, TZ), 0.6, 0xff5040, k=0.7, hair=2, arm=2.6)
    kennel((-4.5, G(-4.5, 6.0), 6.0), 1.2)
    for o in bpy.context.scene.objects:          # onto the summit
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p) for n, (x, y, z), yaw, p in ANIMS]
    join_still('oak')

@piece(REAL)
def football_pitch():
    # Pretzel: the village pitch laid along the road, its lines painted on
    # the lawn, little goals at the ends, and a game on: the ball going round
    # from child to child, two of them chasing it, the keepers waiting.
    PW, PL, T = 26.0, 42.0, 0.36
    W = 'white'
    def line(x, z, w, l, yaw=0.0):
        box((w, 0.26, l), (x, 0.13, z), W, yaw=yaw)
    for s in (-1, 1):
        line(s * PW / 2, 0, T, PL + T)
        line(0, s * PL / 2, PW, T)
        line(0, s * (PL / 2 - 5.5), 14.0, T)                     # the penalty boxes
        for x in (-7.0, 7.0):
            line(x, s * (PL / 2 - 2.75), T, 5.5)
    line(0, 0, PW, T)
    for k in range(16):                                          # the centre circle
        a = (k + 0.5) * 2 * math.pi / 16
        line(4.5 * math.cos(a), 4.5 * math.sin(a), T, 2 * math.pi * 4.5 / 16 + 0.15, yaw=-a)
    # the goals, mouths in toward the middle: a frame and an open net of cords
    GW, GH, GD, NET = 5.0, 2.0, 1.5, 0xd0e8ff
    for s in (-1, 1):
        z0 = s * PL / 2
        for x in (-GW / 2, GW / 2):
            box((0.2, GH, 0.2), (x, GH / 2, z0), 'white')
            box((0.12, 0.12, GD), (x, 0.06, z0 + s * GD / 2), 'white')
            strut((x, GH, z0), (x, 0.06, z0 + s * GD), 0.12, 'white')
        box((GW + 0.2, 0.2, 0.2), (0, GH, z0), 'white')
        box((GW, 0.12, 0.12), (0, 0.06, z0 + s * GD), 'white')
        for k in range(1, 5):
            x = -GW / 2 + GW * k / 5
            strut((x, GH, z0), (x, 0.06, z0 + s * GD), 0.07, NET)
        for k in (1, 2):
            t = k / 3
            box((GW, 0.07, 0.07), (0, GH * (1 - t), z0 + s * GD * t), NET)
    # the keepers on their lines, two players each side standing off
    person((0, 0, -PL / 2 + 1.0), -math.pi / 2, 0x22c46e, k=0.72, hair=1, arm=1.2)
    person((0, 0, PL / 2 - 1.0), math.pi / 2, 0xa259e6, k=0.72, hair=3, arm=1.2)
    for i, (x, z, c) in enumerate(((-6.0, -10.0, 0xff5040), (7.0, -4.0, 0xff5040), (-5.0, 6.0, 0x339cf2),
                                   (6.0, 12.0, 0x339cf2), (2.0, -15.0, 0x339cf2), (-1.0, 15.0, 0xff5040))):
        person((x, 0, z), math.atan2(z, -x), c, k=0.72, hair=i)
    # the ball's round, from player to player (a closed path), and two chasing it
    LOOP = [(-4.5, -9.0), (5.5, -3.5), (-3.5, 5.5), (4.5, 11.0), (0.5, 4.0), (1.5, -13.5)]
    for k, (x, z) in enumerate(LOOP):
        marker('path_ball_%d' % k, (x, 0.0, z))
    with animated('anim_path:c=ball:p=8:o=0:f=0', (LOOP[0][0], 0.0, LOOP[0][1])):
        box((0.64, 0.64, 0.64), (LOOP[0][0], 0.32, LOOP[0][1]), 'white')
    for n, o in enumerate((0.93, 0.45)):
        with animated('anim_path:c=ball:p=8:o=%.2f:f=1#%d' % (o, n), (LOOP[0][0], 0.0, LOOP[0][1])):
            person((LOOP[0][0], 0.0, LOOP[0][1]), 0.0, (0xff5040, 0x339cf2)[n], k=0.72, hair=n + 2, arm=0.5)
    # mums and dads on a bench on the far touchline
    bench((-PW / 2 - 2.5, 0, -3.0), yaw=math.pi / 2)
    bench((-PW / 2 - 2.5, 0, 3.0), yaw=math.pi / 2)
    person((-PW / 2 - 2.6, 0.5, -3.0), 0.0, 0xa259e6, hair=1, sit=True)
    person((-PW / 2 - 2.6, 0.5, 3.3), 0.0, 0xffc044, hair=3, sit=True)
    join_still('pitch')

@piece(REAL)
def den_camp():
    # Pretzel: the children's camp out on the far side of the garden, on its
    # bank (SET_GROUND, like Ribbon's cottages): three tents round a fire
    # with its smoke going up, the children on logs round it, their flag on a
    # pole, a rope swing from the old tree behind.
    s0 = set_ground('den-camp')(0.0, 0.0)
    for k, (a, c) in enumerate(((0.5, 0xff5040), (2.4, 0x339cf2), (4.3, 0x22c46e))):
        tent((4.2 * math.cos(a), 0, 4.2 * math.sin(a)), math.pi - a, c)
    for k in range(6):                                   # the fire's ring of stones
        a = k * math.pi / 3
        box((0.5, 0.35, 0.5), (0.9 * math.cos(a), 0.17, 0.9 * math.sin(a)), 'grey', yaw=a)
    for a in (0.3, 1.9):
        box((1.4, 0.3, 0.3), (0, 0.25, 0), 0x7a5a3a, yaw=a)
    box((0.6, 0.7, 0.6), (0, 0.55, 0), 0xff7e44, yaw=0.4)
    box((0.35, 0.5, 0.35), (0.1, 0.95, 0.05), 0xffc044, yaw=0.9)
    marker('anim_smoke', (0, 1.3, 0))
    for k, (a, c) in enumerate(((1.45, 0xffc044), (3.35, 0xa259e6), (5.6, 0xf8f8fb))):
        x, z = 2.2 * math.cos(a), 2.2 * math.sin(a)
        box((0.5, 0.4, 1.4), (x, 0.2, z), 0x7a5a3a, yaw=-a)
        person((x, 0.4, z), math.pi - a, c, k=0.66, hair=k, sit=True, arm=0.5)
    flagpole((-2.6, 0, -4.6), 3.4, 0xff5040, w=1.2, fh=0.7, pole=0x9a7b55, wave='anim_sway:a=z:d=22:p=1.4')
    TX, TZ = -6.5, 1.5                                   # the tree and its rope swing
    cyl(0.7, 6.5, (TX, 0, TZ), 0x7a5a3a, r2=0.45, segs=7)
    sphere(3.2, (TX, 8.2, TZ), 0x5f9f4a, subdiv=1)
    strut((TX, 5.4, TZ), (TX + 3.0, 6.0, TZ), 0.4, 0x7a5a3a)
    with animated('anim_sway:a=z:d=26:p=2.6', (TX + 2.6, 5.9, TZ)):
        strut((TX + 2.6, 5.9, TZ), (TX + 2.6, 0.9, TZ), 0.08, 0x9a7b55)
        box((0.5, 0.1, 0.7), (TX + 2.6, 0.85, TZ), 0x9a7b55)
        person((TX + 2.5, 0.9, TZ), 0.0, 0x339cf2, k=0.64, hair=2, sit=True, arm=1.3)
    for o in bpy.context.scene.objects:          # onto the bank
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p) for n, (x, y, z), yaw, p in ANIMS]
    join_still('camp')

# ---- TANGLE: the mill stream ------------------------------------------------------------
# Tangle's stream rises out of the east lawn, runs under the S-bend's bridge
# and the first bridge and over the north lawn to the mill pond on the west,
# ahead of the grid, where the watermill's wheel turns in the race. The
# stream is laid reach by reach (set-stream-reach, each placed along its
# stretch, their tapered ends overlapping); the mill is the hero. Water is a
# flat sheet on the lawn: from a deck riding over the garden it reads as a
# line of blue across the map.
WATER, MUD = 0x7db8e8, 0xb08a5a
STREAM_W, REACH = 4.2, 88.0   # its half width; a reach's length between its end circles

@piece(REAL)
def stream_reach():
    # One reach of the stream, a steady width with a round end each side:
    # laid end to end, each reach's end circle on the next one's, the water
    # joins round any bend (same height, same colour, so where two lie over
    # each other nothing shows). REACH between the two circles' centres; a
    # mud margin, a few stones and reeds. ONE part, one draw wherever it is,
    # and it DRAPES: the water lies on the lawn as the renderer draws it, up
    # the ground raised under a deck as well, never sunk under it.
    W, M = STREAM_W, 1.2
    zc = REACH / 2
    def ribbon(w, y, color):
        pts = []
        for t in range(7):                                  # the +Z cap, from its tip
            a = (6 - t) * math.pi / 12
            pts.append((zc + w * math.sin(a), w * math.cos(a)))
        for i in range(1, 10):
            pts.append((zc - REACH * i / 10, w))
        for t in range(7):                                  # the -Z cap, to its tip
            a = t * math.pi / 12
            pts.append((-zc - w * math.sin(a), w * math.cos(a)))
        verts, faces = [], []
        for i, (z, h) in enumerate(pts):
            verts += [(h, y, z), (-h, y, z)]
            if i:
                faces.append((2 * i - 2, 2 * i, 2 * i + 1, 2 * i - 1))
        ground_poly(verts, faces, color)
    ribbon(W + M, 0.12, MUD)
    ribbon(W, 0.28, WATER)
    for i, (x, z, r) in enumerate(((4.4, -30.0, 0.9), (-4.6, -10.0, 0.8), (4.8, 14.0, 1.0), (-0.4, 2.6, 0.7))):
        box((r * 1.3, 0.6 * r, r), (x, 0.3 * r, z), ('grey', 'lavender')[i % 2], yaw=i * 0.9)
    for k, (x, z) in enumerate(((5.6, -20.0), (-5.6, 26.0))):
        for j in range(3):
            a = j * 1.7 + k
            box((0.18, 1.6 - 0.2 * j, 0.18), (x + 0.4 * math.cos(a), 0.8 - 0.1 * j, z + 0.4 * math.sin(a)),
                (0x4f9a48, 0x61cb8b, 0x9a7b55, 0x4f9a48)[j], yaw=a)
    join_still('drape_reach')

def duck(at, color=0xf8f8fb):
    """A duck on the water facing +X: body, tail, head, bill (twice life size)."""
    x, y, z = at
    box((0.9, 0.38, 0.5), (x, y + 0.19, z), color)
    box((0.3, 0.3, 0.36), (x - 0.5, y + 0.3, z), color, roll=0.5)
    box((0.3, 0.42, 0.3), (x + 0.36, y + 0.55, z), 0x22c46e if color != 0xf8f8fb else color)
    box((0.26, 0.1, 0.18), (x + 0.6, y + 0.62, z), 0xff7e44)

@piece(REAL)
def watermill():
    # The mill on its pond: a stone mill house (front +X, to the road) under
    # a red tile roof, the wheel on its road side turning in the race that
    # runs out of the pond past it; ducks going round the pond, a weeping
    # willow over the water, someone fishing off the bank. Real size: the
    # house is two cars long, the wheel nearly two across.
    STONE, TILE = 0xfde4c7, 0xcf534f
    PX, PZ, PR = -1.0, -20.0, 13.0                    # the pond, upstream (-Z) of the house
    cyl(PR + 1.4, 0.14, (PX, 0, PZ), MUD, segs=20)
    cyl(PR, 0.3, (PX, 0, PZ), WATER, segs=20)
    # the race: out of the pond's +X side past the wheel, on along +Z
    RX = 6.6
    box((3.4, 0.14, 26.0), (RX, 0.07, 2.0), MUD)
    box((2.2, 0.3, 26.0), (RX, 0.15, 2.0), WATER)
    for s in (-1, 1):
        box((0.5, 0.7, 26.0), (RX + s * 1.4, 0.35, 2.0), 'grey')
    # the house
    F = local(0, 0, 0)
    D, L, H = 9.0, 11.0, 7.0
    box((D, H, L), (0, H / 2, 0), STONE)
    gable_roof(F, 0.0, 0.0, D, L, H, TILE, STONE)
    box((1.2, 3.0, 1.2), (-1.5, H + 4.0, -3.5), 0xb06041)
    box((0.14, 2.6, 1.6), (-0.1, 1.3, L / 2 + 0.05), 0x7a5a3a, yaw=math.pi / 2)   # its door on the downstream gable
    for z in (-3.0, 3.0):
        window(F, 0.0, D / 2, 4.6, z, w=1.2, h=1.2)
    box((1.2, 1.0, 1.0), (2.0, 0.5, L / 2 + 1.2), 0xfde4c7)                       # sacks at the door
    # the wheel, axle across (X), turning so its foot runs downstream
    WX, WY, WZ, R = RX, 3.4, 0.0, 3.4
    with animated('anim_spin:a=x:w=-0.9', (WX, WY, WZ)):
        cyl(0.5, 1.8, (WX - 0.9, WY, WZ), 0x2a2735, segs=8, axis='across')
        for s in (-1, 1):
            torus(R, 0.22, (WX + s * 0.6, WY, WZ), 0x7a5a3a, segs=16, axis='across')
        for k in range(12):
            a = k * 2 * math.pi / 12
            dy, dz = math.sin(a), math.cos(a)
            box((1.4, 0.16, 1.0), (WX, WY + dy * (R - 0.3), WZ + dz * (R - 0.3)), 0x9a7b55, pitch=a)
        for k in range(4):
            a = k * math.pi / 4
            for s in (-1, 1):
                box((0.25, 0.25, 2 * R), (WX + s * 0.6, WY, WZ), 0x7a5a3a, pitch=a)
    # the pond's life: three ducks going round it, the willow, the angler
    n = 10
    for k in range(n):
        a = -k * 2 * math.pi / n
        marker('path_duck_%d' % k, (PX + 8.0 * math.cos(a), 0.3, PZ + 8.0 * math.sin(a)))
    for j in range(3):
        a0 = 0.0
        with animated('anim_path:c=duck:p=26:o=%.3f:f=1#%d' % (j / 3 + 0.04 * j, j), (PX + 8.0, 0.3, PZ)):
            duck((PX + 8.0, 0.3, PZ), (0xf8f8fb, 0x9a7b55, 0xf8f8fb)[j])
    WLX, WLZ = PX - 10.0, PZ - 8.0
    cyl(0.8, 8.0, (WLX, 0, WLZ), 0x7a5a3a, r2=0.5, segs=7)
    sphere(4.6, (WLX, 9.6, WLZ), 0x6cae55, subdiv=1, scale=(1.0, 0.7, 1.0))
    cyl(5.0, 6.0, (WLX, 3.4, WLZ), 0x61cb8b, r2=4.2, segs=10)
    AX, AZ = PX - PR - 2.2, PZ + 4.0
    bench((AX, 0, AZ), yaw=math.pi / 2)
    person((AX - 0.1, 0.5, AZ), 0.0, 0x22c46e, hair=1, sit=True, arm=0.6)
    strut((AX + 0.3, 0.9, AZ + 0.35), (AX + 5.0, 3.0, AZ + 0.35), 0.1, 0x2a2735)
    for k, (x, z) in enumerate(((PX - 12.0, PZ + 5.0), (PX + 6.0, PZ - 11.5), (PX - 4.0, PZ + 12.6))):
        for j in range(4):
            a = j * 1.7 + k
            box((0.2, 1.8 - 0.2 * j, 0.2), (x + 0.5 * math.cos(a), 0.9 - 0.1 * j, z + 0.5 * math.sin(a)),
                (0x4f9a48, 0x61cb8b, 0x9a7b55, 0x4f9a48)[j], yaw=a)
    join_still('mill')

# ---- CLOVERLEAF: the playground on the hill -----------------------------------------
# Cloverleaf's playground at the size of a real one, on the broad top of its
# hill (SET_GROUND, built from the summit and lifted onto it): a climbing tower
# with a slide off it, the rope climbing net standing over the rest, swings, a
# seesaw, a roundabout and a spring rider, every one with a child on it and
# moving, a sandpit, the mums and dads on the benches.

def kid_swing(n, x, z, top, shirt, hair):
    with animated('anim_sway:a=z:d=32:p=%.1f#%d' % (2.3 + 0.25 * n, n), (x, top, z)):
        for s in (-1, 1):
            strut((x, top - 0.05, z + s * 0.32), (x, 0.62, z + s * 0.32), 0.07, 0x9aa1b4)
        box((0.55, 0.1, 0.75), (x, 0.58, z), 0xff5040)
        person((x - 0.1, 0.63, z), 0.0, shirt, k=0.68, hair=hair, sit=True, arm=1.3)

@piece(REAL)
def playground():
    H = set_ground('playground')
    s0 = H(0.0, 0.0)
    # bark under it all, its edge bedded into the hill
    box((19.0, 0.6, 21.0), (0, -0.18, 0), 0xb08a5a)
    # the swings: an A-frame each end of a top bar along Z
    SX, top = -5.0, 2.6
    for z in (-9.0, -3.0):
        for s in (-1, 1):
            strut((SX + s * 1.3, 0, z), (SX, top, z), 0.2, 0x339cf2)
    box((0.24, 0.24, 6.4), (SX, top, -6.0), 0x339cf2)
    kid_swing(0, SX, -7.4, top, 0xffc044, 1)
    kid_swing(1, SX, -4.6, top, 0x22c46e, 2)
    # the climbing tower: a deck on four posts under a red roof, a slide off its
    # road side (+X), a ladder up its back
    TX, TZ, DY = 1.5, 5.0, 1.6
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.24, 3.4, 0.24), (TX + sx * 1.0, 1.7, TZ + sz * 1.0), 0xffc044)
    box((2.4, 0.2, 2.4), (TX, DY, TZ), 0x9a7b55)
    for sz in (-1, 1):
        box((2.2, 0.8, 0.12), (TX, DY + 0.5, TZ + sz * 1.05), 0x339cf2)
    box((2.8, 0.16, 1.7), (TX, 3.65, TZ - 0.55), 0xff5040, roll=0.0, pitch=0.6)
    box((2.8, 0.16, 1.7), (TX, 3.65, TZ + 0.55), 0xff5040, pitch=-0.6)
    a = math.atan2(DY - 0.3, 3.6)
    for s in (-1, 1):
        box((3.9, 0.3, 0.12), (TX + 1.1 + 1.8, (DY + 0.3) / 2 + 0.12, TZ + s * 0.45), 0xff5040, roll=a)
    box((3.9, 0.1, 0.9), (TX + 1.1 + 1.8, (DY + 0.3) / 2, TZ), 0xff5040, roll=a)
    for s in (-1, 1):
        strut((TX - 2.2, 0, TZ + s * 0.4), (TX - 1.0, DY, TZ + s * 0.4), 0.12, 0x9aa1b4)
    for i in range(4):
        t = (i + 0.7) / 4.5
        box((0.12, 0.1, 0.8), (TX - 2.2 + 1.2 * t, DY * t, TZ), 0x9aa1b4)
    person((TX + 0.3, DY + 0.1, TZ - 0.3), 0.3, 0xa259e6, k=0.68, hair=3)
    # the seesaw, a child each end
    QX, QZ = 6.0, -2.0
    box((0.4, 0.6, 0.5), (QX, 0.3, QZ), 0x339cf2)
    with animated('anim_sway:a=x:d=12:p=2.6', (QX, 0.65, QZ)):
        box((0.35, 0.12, 4.4), (QX, 0.65, QZ), 0x22c46e)
        for s in (-1, 1):
            box((0.12, 0.45, 0.12), (QX, 0.92, QZ + s * 1.55), 0x9aa1b4)
            person((QX, 0.71, QZ + s * 1.95), (math.pi / 2 if s > 0 else -math.pi / 2), (0xff5040, 0x339cf2)[s > 0],
                   k=0.66, hair=s + 1, sit=True, arm=1.0)
    # the roundabout turning, two children riding it
    RX, RZ = 2.0, -6.5
    box((0.6, 0.3, 0.6), (RX, 0.15, RZ), 0x9aa1b4)
    with animated('anim_spin:w=1.2', (RX, 0.3, RZ)):
        cyl(1.25, 0.16, (RX, 0.3, RZ), 0xffc044, segs=12)
        cyl(0.12, 1.0, (RX, 0.46, RZ), 0x9aa1b4, segs=6)
        for k in range(4):
            a = k * math.pi / 2
            strut((RX, 1.4, RZ), (RX + math.cos(a) * 1.05, 0.95, RZ + math.sin(a) * 1.05), 0.1, 0xff5040)
            box((0.1, 0.5, 0.1), (RX + math.cos(a) * 1.05, 0.7, RZ + math.sin(a) * 1.05), 0xff5040)
        for k, c in ((0, 0xf8f8fb), (2, 0x22c46e)):
            a = k * math.pi / 2 + math.pi / 4
            person((RX + math.cos(a) * 0.75, 0.46, RZ + math.sin(a) * 0.75), -a + math.pi, c, k=0.66, hair=k, sit=True)
    # the spring rider, rocking
    with animated('anim_sway:a=z:d=18:p=0.9', (-1.5, 0.1, 1.0)):
        box((0.2, 0.7, 0.2), (-1.5, 0.35, 1.0), 0x2a2735)
        box((1.1, 0.5, 0.45), (-1.5, 0.95, 1.0), 0x22c46e)
        box((0.35, 0.5, 0.35), (-1.0, 1.35, 1.0), 0x22c46e)
        person((-1.6, 1.15, 1.0), 0.0, 0xff5040, k=0.6, hair=2, sit=True, arm=1.2)
    # the sandpit, a child in it digging
    for s in (-1, 1):
        box((3.6, 0.3, 0.25), (-5.5, 0.15, 5.0 + s * 1.7), 0x9a7b55)
        box((0.25, 0.3, 3.6), (-5.5 + s * 1.7, 0.15, 5.0), 0x9a7b55)
    box((3.2, 0.24, 3.2), (-5.5, 0.12, 5.0), 0xfde4c7)
    person((-5.6, 0.2, 5.3), 0.4, 0x339cf2, k=0.6, hair=0)
    box((0.4, 0.4, 0.4), (-4.9, 0.4, 4.4), 0xff5040)
    # the climbing net: a rope pyramid on a mast, the tallest thing in the
    # park as it is in a real one (about seven metres), two children up it
    NX, NZ, NH, NR = -2.0, 8.6, 7.0, 2.6
    cyl(0.16, NH, (NX, 0, NZ), 0x9aa1b4, segs=6)
    box((0.5, 0.3, 0.5), (NX, NH + 0.1, NZ), 0xff5040)
    ring = [(NX + NR * math.cos(k * math.pi / 4), NZ + NR * math.sin(k * math.pi / 4)) for k in range(8)]
    for x, z in ring:
        strut((x, 0.05, z), (NX, NH, NZ), 0.16, 0xff5040)
    for f in (0.33, 0.66):
        for k in range(8):
            (x0, z0), (x1, z1) = ring[k], ring[(k + 1) % 8]
            strut((NX + (x0 - NX) * (1 - f), NH * f, NZ + (z0 - NZ) * (1 - f)),
                  (NX + (x1 - NX) * (1 - f), NH * f, NZ + (z1 - NZ) * (1 - f)), 0.12, 0xff5040)
    person((NX + 1.3, NH * 0.33 + 0.05, NZ - 1.4), 2.3, 0x22c46e, k=0.62, hair=1, arm=2.4)
    person((NX - 0.6, NH * 0.66 + 0.05, NZ + 0.5), 0.9, 0xffc044, k=0.6, hair=2, arm=2.6)
    # the benches round it, two of the grown-ups watching
    for z, c in ((-3.0, 0xa259e6), (6.5, 0xffc044)):
        bench((-8.4, 0, z), yaw=math.pi / 2)
        person((-8.5, 0.5, z + 0.2), 0.0, c, hair=1 if z < 0 else 3, sit=True)
    for o in bpy.context.scene.objects:          # onto the summit
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p) for n, (x, y, z), yaw, p in ANIMS]
    join_still('playground')

@piece(REAL)
def ice_cream_van():
    # The park's ice-cream van round the hill's foot, so the playground's
    # afternoon reaches the rest of the lap: a van parked along a gravel
    # lay-by (its length Z, the serving hatch on the road side, +X) under
    # the big cone on its roof turning, the children queueing at the hatch,
    # one hopping, a grown-up on the bench with a cone. Real size: about one
    # and a half cars long.
    BODY, TRIM = 0xf8f8fb, 0x339cf2
    box((4.6, 0.1, 9.0), (1.2, 0.05, 0.0), 0xfde4c7)                 # the lay-by
    box((2.3, 1.3, 6.2), (0, 1.15, -0.2), BODY)                       # the body
    box((2.32, 0.3, 6.22), (0, 0.65, -0.2), TRIM)                     # its skirt
    box((2.3, 1.5, 4.4), (0, 2.55, -1.1), BODY)                       # the box behind the cab
    box((2.32, 0.28, 4.42), (0, 2.0, -1.1), TRIM)                     # the stripe round it
    box((2.2, 0.9, 1.5), (0, 2.1, 2.0), BODY, pitch=-0.35)            # the cab roof sloping to the bonnet
    box((1.9, 0.7, 0.12), (0, 2.05, 2.78), 0x8ecae6, pitch=-0.35)     # the windscreen
    box((2.1, 0.2, 0.3), (0, 0.65, 2.95), 'grey')                     # the bumper
    for s in (-1, 1):
        box((0.4, 0.3, 0.1), (s * 0.75, 1.15, 2.92), 0xffc044)        # the lamps
        box((0.12, 0.7, 0.9), (s * 1.16, 2.05, 1.9), 0x8ecae6)        # the cab's side windows
    for sz in (-2.1, 1.8):
        for x in (1.0, -1.4):
            cyl(0.5, 0.4, (x, 0.5, sz), 0x2a2735, segs=8, axis='across')
    # the serving hatch, its awning out over the queue, the menu under it
    box((0.12, 0.95, 2.4), (1.16, 2.55, -1.3), 0x2a2735)
    box((0.9, 0.1, 2.8), (1.55, 3.2, -1.3), 0xff5040, roll=-0.35)
    box((0.1, 0.5, 1.6), (1.18, 1.5, -1.3), 0xffc044)
    # the cone on the roof, turning: the wafer and two scoops
    with animated('anim_spin:w=1.1', (0, 3.3, -1.1)):
        cyl(0.12, 1.3, (0, 3.3, -1.1), 0xd9b054, r2=0.55, segs=8)
        sphere(0.62, (0, 4.85, -1.1), 0xf1976c)
        sphere(0.45, (0, 5.5, -1.1), 0xfde4c7)
    # the queue at the hatch, facing it, the second child hopping
    person((2.3, 0, -1.6), math.pi, 0xff5040, k=0.68, hair=1, arm=0.6)
    with animated('anim_bob:h=0.25:p=0.8', (3.0, 0, -0.4)):
        person((3.0, 0, -0.4), math.pi * 0.9, 0x22c46e, k=0.64, hair=2, arm=2.4)
    person((3.4, 0, 0.8), math.pi * 0.85, 0xa259e6, k=0.7, hair=3)
    person((3.7, 0, 1.9), math.pi * 0.85, 0x339cf2, hair=0)
    # the bench along the back of the lay-by, a grown-up with a cone
    bench((3.4, 0, -3.6), yaw=-math.pi / 2)
    person((3.5, 0.5, -3.6), math.pi, 0xffc044, hair=3, sit=True, arm=1.0)
    join_still('van')

# ====================================================================================
# CANYON
# ====================================================================================

TIMBER, BONE, ROPE = 0x8a5f3e, 0xf8f8fb, 0x2a2735

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

def longhorn_skull(at, yaw=0.0, k=1.0):
    """A bleached longhorn skull resting on its jaw, its face to +X turned by
    `yaw`: the cranium, a snout, dark sockets and nostrils, horns sweeping out
    and up."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def L(dx, dy, dz):
        return (x + (dx * c + dz * s) * k, y + dy * k, z + (-dx * s + dz * c) * k)
    def part(size, d, color):
        box([v * k for v in size], L(*d), color, yaw=yaw)
    part((0.6, 0.8, 0.9), (0, 0.55, 0), BONE)                       # cranium
    part((0.8, 0.45, 0.55), (0.5, 0.3, 0), BONE)                     # snout
    for sd in (-1, 1):
        part((0.1, 0.24, 0.24), (0.31, 0.72, sd * 0.24), 'dark')     # sockets
        part((0.1, 0.12, 0.1), (0.91, 0.38, sd * 0.11), 'dark')      # nostrils
        part((0.3, 0.26, 0.42), (0.0, 0.86, sd * 0.6), BONE)         # horn root
        pts = [(0.0, 0.86, sd * 0.75), (0.1, 0.9, sd * 1.35), (0.3, 1.02, sd * 1.8), (0.6, 1.25, sd * 2.0)]
        tube([L(*p) for p in pts], 0.11 * k, 'cream', res=3)

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
    twiggy rather than solid."""
    sphere(r, at, 0xb8a686, subdiv=1)
    sphere(r * 0.97, at, 0x8a6a46, subdiv=1, scale=(1.0, 1.08, 1.0), yaw=0.63)

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
    # between dark banks, stones and a bleached skull on the bars, a dead
    # cottonwood on the bank. Tumbleweeds blow down it: each rolls out of the
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
    dead_tree((-6.0, 0, zc(-6.0) + 4.4), h=6.5)
    sandstone_rock((-4.4, 0, zc(-4.4) + 3.2), 0.8, yaw=0.4)
    longhorn_skull((4.6, 0, zc(4.6) - 2.4), yaw=0.3, k=0.8)
    sandstone_rock((10.0, 0, zc(10.0) + 3.0), 0.7, yaw=1.2)
    # the tumbleweeds' loop: down the bed at its own height, then back under it
    R = 0.5
    xs = [-END + 2 * END * i / 12 for i in range(13)]
    for k, pt in enumerate([(x, R, zc(x)) for x in xs] + [(END, -1.9, zc(END)), (-END, -1.9, zc(-END))]):
        marker('path_weed_%d' % k, pt)
    for n in range(3):
        x = xs[2 + 3 * n]
        with animated('anim_path:c=weed:p=12:o=%.3f:f=1+spin:a=z:w=-5+bob:h=0.25:p=0.65#%d' % (n / 3, n),
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

@piece(1.45)
def mine_portal():
    # Gulch: the mine. The adit's timber portal is cut into the foot of a rock
    # spur (the piece's SET_GROUND ridge behind it, -X; the track's own ridge
    # rises beyond), a headwall of blocky rock round it; a narrow-gauge line
    # runs out of it toward the road (+X), under the tipple (a bin on a
    # trestle, its spout over a cart) to a buffer stop. The ore line branches
    # off it just outside the adit (set-ore-line, on this piece's anchor), and
    # its carts come out of the dark of the adit. The powder shed stands
    # upstream (-Z), its flag flapping; the yard in front is the plain the
    # SET_GROUND levels.
    # the headwall: two buttresses and a lintel block, sunk into the spur's
    # slope (a block standing higher reads as a slab perched on it)
    for (x, y, z, sx, sy, sz, c, yw) in (
            (-5.0, 1.6, -3.3, 2.4, 3.6, 2.4, 0xa96545, 0.2),
            (-4.9, 1.6, 3.3, 2.2, 3.6, 2.4, 0xc47a52, -0.3),
            (-5.6, 3.7, 0.0, 2.8, 1.6, 6.2, 0xa96545, 0.05)):
        box((sx, sy, sz), (x, y, z), c, yaw=yw)
    box((1.4, 3.0, 2.6), (-3.8, 1.5, 0), ROPE)                                   # the adit
    for z in (-1.5, 1.5):
        box((0.5, 3.6, 0.5), (-3.2, 1.8, z), TIMBER)
    box((0.6, 0.5, 4.2), (-3.2, 3.75, 0), TIMBER)
    for z in (-2.4, 2.4):                                                        # lamps either side
        box((0.2, 2.4, 0.2), (-2.2, 1.2, z), 'slate')
        box((0.4, 0.4, 0.4), (-2.2, 2.5, z), 'yellow')
    for z in (-0.55, 0.55):                                                      # the line
        box((16.5, 0.14, 0.14), (4.8, 0.12, z), 'slate')
    for k in range(17):
        box((0.3, 0.1, 1.6), (-3.0 + k * 1.0, 0.04, 0), TIMBER)
    box((0.6, 0.9, 1.8), (13.3, 0.45, 0), TIMBER)                                # buffer stop
    box((0.3, 0.3, 2.2), (13.0, 0.75, 0), 'red')
    ore_cart((6.0, 0.12, 0), yaw=math.pi / 2, ore_color='yellow')                # loading under the tipple
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
        box((0.1, 4.4, 0.1), (7.85, 2.2, -1.2 + s * 0.3), TIMBER)
    for i in range(6):
        box((0.1, 0.08, 0.6), (7.85, 0.5 + i * 0.7, -1.2), TIMBER)
    for k, (x, z) in enumerate(((8.6, 2.2), (9.4, 2.8), (8.9, 3.4))):            # gold ore spilled by the tipple
        box((0.55, 0.4, 0.55), (x, 0.2, z), 'yellow' if k % 2 == 0 else 0xa8623f, yaw=0.6 * k)
    kit('survival', 'tool-shovel', (9.6, 0, 1.6), yaw=0.6, scale=2.4, roll=0.35)
    # the powder shed, set back from the line, its blasting gear by the door
    hut(2.6, 2.0, 2.4, (1.4, 0, -6.8), TIMBER, 'slate')
    for k, (x, z, y) in enumerate(((3.4, -5.5, 0), (3.4, -6.5, 0), (3.4, -6.0, 0.8))):
        box((0.9, 0.8, 0.9), (x, y + 0.4, z), 0x9a7b55, yaw=0.1 * k)
    for k in range(4):
        box((0.16, 0.16, 0.6), (3.2 + k * 0.16, 1.7, -6.0), 'red')
    box((0.5, 0.45, 0.45), (4.5, 0.22, -7.6), 'slate')
    box((0.1, 0.5, 0.1), (4.5, 0.7, -7.6), ROPE)
    flagpole((-0.4, 0, -8.8), 3.4, 'red', w=1.0, fh=0.6, wave='anim_sway:a=z:d=24:p=2.0#1')
    kit('pirate', 'barrel', (-1.2, 0, -3.2), yaw=0.3, scale=0.5)
    kit('pirate', 'barrel', (-1.8, 0, -3.8), yaw=1.4, scale=0.5)
    kit('survival', 'tool-pickaxe', (-1.6, 0, 3.2), yaw=0.4, scale=2.6, roll=0.25)

@piece(1.35)
def telegraph_line():
    # Sidewinder: a telegraph line straight across the desert along the long
    # straight (+-Z), its poles stood clear of the road (the offsets come from
    # the track: scratch work, see the piece's set entry), crossarms ACROSS the
    # line, three wires sagging between poles. Each end pole is stayed by a guy
    # wire to an anchor, and the line drops into a lineman's hut at its far end
    # (the near end stops short of a mesa); a highway sign faces the oncoming
    # traffic by the straight.
    zs = [d / 1.35 for d in (-122, -106, -90, -74, -42, -26, -10, 6, 22, 38, 54, 70, 86, 102, 118, 134, 150)]   # world units / GROW
    H = 6.2
    arm = (-0.85, 0.0, 0.85)
    for z in zs:
        cyl(0.17, H, (0, 0, z), TIMBER, r2=0.12, segs=8, smooth=False)
        box((2.2, 0.24, 0.24), (0, H - 0.5, z), TIMBER)
        for x in arm:
            box((0.2, 0.3, 0.2), (x, H - 0.24, z), 'white')
    for x in arm:
        for z0, z1 in zip(zs[:-1], zs[1:]):
            tube(sag((x, H - 0.1, z0), (x, H - 0.1, z1), 0.04 * (z1 - z0), n=3), 0.045, ROPE, res=1, bevel_res=0, wire=True)
    for z, d in ((zs[0], -1), (zs[-1], 1)):                                      # the stays
        dy, dz = 0.3 - (H - 0.6), d * 4.2
        box((0.1, 0.1, math.hypot(dy, dz)), (0, (H - 0.6 + 0.3) / 2, z + dz / 2), ROPE, pitch=math.atan2(dy, dz))
        box((0.4, 0.3, 0.4), (0, 0.15, z + d * 4.3), TIMBER)
    hut(2.4, 2.0, 2.2, (2.8, 0, zs[-1] + 1.4), 0x9a7b55, 'slate', yaw=math.pi / 2)   # the lineman's hut
    tube(sag((0.85, H - 0.1, zs[-1]), (2.8, 2.7, zs[-1] + 1.4), 0.3, n=4), 0.045, ROPE, res=2, bevel_res=0, wire=True)
    box((0.2, 2.4, 0.2), (-1.6, 1.2, -4.0), 'slate')
    box((1.4, 1.0, 0.12), (-1.6, 2.9, -4.12), 0xd9b054)
    box((1.0, 0.2, 0.14), (-1.6, 2.9, -4.2), ROPE)
    box((0.2, 1.2, 0.2), (-1.6, 0.6, 14.0), 'cream')

@piece(1.5)
def dead_cottonwood():
    # Wash's support: a lone dead cottonwood, a vulture perched on its top
    # looking out at the road, a fallen limb, red rocks and a tumbleweed at
    # its foot.
    dead_tree((0, 0, 0), h=8.0, color=0x8a6a46)
    o = cyl(0.2, 3.6, (1.2, 0.2, 1.0), 0x8a6a46, r2=0.1, segs=5, axis='along', smooth=False)
    o.rotation_euler.z = 0.6
    vy, k = 8.0, 1.3                                                             # the vulture
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
    sphere(0.55, (-1.8, 0.5, 2.2), 0xb8a686, subdiv=1)

@piece(0.5)
def rattlesnake():
    # Sidewinder: a big toy rattlesnake coiled on a low grey slab, mustard
    # with dark diamonds so it reads against the rock and the sand. Its head
    # rears on an S of neck toward the road (+X) and sways side to side,
    # watching the traffic (anim_sway); the rattle held up behind shakes
    # (anim_sway, fast). Built lean, a square-section coil: it is small on the
    # verge and every cell that passes it draws it.
    sphere(1.0, (0, 0.05, 0), 'grey', subdiv=1, scale=(2.7, 0.4, 2.4), flat=True)
    turns, n = 2.0, 11
    coil = []
    for i in range(n):
        f = i / (n - 1)
        a = f * turns * 2 * math.pi
        r = 1.45 - 0.75 * f
        coil.append((math.cos(a) * r, 0.6 + 0.62 * f, math.sin(a) * r))
    tube(coil, 0.3, 'yellow', res=2, bevel_res=0)
    for i in (2, 4, 6, 8):                                                        # the diamonds
        x, y, z = coil[i]
        a = math.atan2(z, x)
        box((0.36, 0.12, 0.36), (x, y + 0.28, z), 'brown', yaw=-a + math.pi / 4)
    base = coil[-1]
    head = (0.6, 3.1, 0.0)
    with animated('anim_sway:a=y:d=30:p=1.7', base):
        tube([base, (0.0, 1.9, 0.12), (-0.15, 2.6, 0.05), (0.15, 3.05, 0.0), head], 0.3, 'yellow',
             res=2, bevel_res=0)
        box((0.95, 0.42, 0.7), (head[0] + 0.2, head[1], head[2]), 'yellow')
        box((0.6, 0.1, 0.5), (head[0] + 0.2, head[1] + 0.24, head[2]), 'brown')
        for s in (-1, 1):
            box((0.16, 0.16, 0.1), (head[0] + 0.4, head[1] + 0.12, s * 0.36), 'dark')
        box((0.5, 0.06, 0.1), (head[0] + 0.9, head[1] - 0.08, 0), 'red')
    tail = coil[0]
    with animated('anim_sway:a=x:d=22:p=0.24', (tail[0] + 0.1, tail[1] + 0.15, tail[2] - 0.25)):
        for k in range(3):                                                        # the rattle
            box((0.3 - k * 0.05, 0.26, 0.3 - k * 0.05), (tail[0] + 0.1, tail[1] + 0.3 + k * 0.26, tail[2] - 0.25), 'cream')
    sandstone_rock((3.2, 0, -1.4), 0.8, yaw=1.1)

@piece(1.5)
def cow_skull():
    # Sidewinder: a bleached longhorn skull sat up on the sand facing
    # the road, a rib and a leg bone strewn by it, a low red rock behind.
    longhorn_skull((0, 0, 0), yaw=0.0, k=1.0)
    sandstone_rock((-1.6, 0, -0.8), 0.7, yaw=0.5)
    for k, (x, z, yw) in enumerate(((0.9, 1.6, 0.5), (1.3, -1.4, -0.4), (0.4, 2.4, 1.2))):
        box((0.18, 0.16, 0.9 - 0.15 * k), (x, 0.08, z), BONE, yaw=yw)

@piece(1.45)
def ranch_fence():
    # Wash: a small split-rail corral, its gate swung open toward the
    # road (+X), a water trough and a hay bale inside.
    S = 2.4
    posts = [(-S, -S), (0, -S), (S, -S), (S, 0), (S, S), (0, S), (-S, S), (-S, 0)]
    for x, z in posts:
        box((0.24, 1.5, 0.24), (x, 0.75, z), TIMBER)
    for a, b in zip(posts, posts[1:] + posts[:1]):
        if a == (S, 0) and b == (S, S):
            continue                                                             # the gateway
        mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        along = abs(b[1] - a[1]) > abs(b[0] - a[0])
        for y in (0.6, 1.15):
            box((0.12, 0.14, S) if along else (S, 0.14, 0.12), (mx, y, mz), 0x9a7b55)
    th = math.radians(75)                                                        # the gate, hung on (S, 0)
    dx, dz = math.sin(th), math.cos(th)
    for y in (0.55, 1.1):
        box((0.12, 0.14, S - 0.2), (S + dx * S / 2, y, dz * S / 2), 0x9a7b55, yaw=th)
    box((0.14, 0.8, 0.14), (S + dx * (S - 0.15), 0.8, dz * (S - 0.15)), 0x9a7b55)
    box((0.1, 0.1, S * 0.95), (S + dx * S / 2, 0.83, dz * S / 2), 0x9a7b55, yaw=th, pitch=0.24)
    box((0.9, 0.5, 1.7), (-1.3, 0.25, -1.0), 'grey')                              # trough
    box((0.7, 0.05, 1.5), (-1.3, 0.51, -1.0), 0x62d3c8)
    box((0.9, 0.6, 1.2), (-1.2, 0.3, 1.2), 'yellow', yaw=0.3)                     # hay bale
    box((0.95, 0.06, 0.08), (-1.2, 0.61, 1.2), 'brown', yaw=0.3)

@piece(1.45)
def route_sign():
    # Sidewinder: a desert route sign on two posts, a mile marker beside it.
    for z in (-0.7, 0.7):
        box((0.2, 2.4, 0.2), (0, 1.2, z), 'slate')
    box((0.12, 1.2, 2.2), (0.12, 2.3, 0), 0x22c46e)
    box((0.14, 0.2, 1.6), (0.2, 2.5, 0), 'cream')
    box((0.14, 0.2, 1.0), (0.2, 2.1, -0.3), 'cream')
    box((0.22, 1.0, 0.3), (0.3, 0.5, 1.8), 'cream')
    box((0.24, 0.2, 0.32), (0.3, 0.85, 1.8), 0x22c46e)

@piece(1.45)
def headframe():
    # Gulch: the far end of the mine's ore line, where a shaft goes straight
    # down: a timber headframe over the shaft collar, its back legs braced
    # toward the hoist house (-X) the cable comes from, the big sheave wheel
    # on top turning as the cage winds (anim_spin), the cable over it and
    # down to the cage; the ore line (set-ore-line) runs up to the collar from
    # +X, and its carts roll onto the collar and down the shaft.
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
            box((0.16, 2.8, 0.16), (0, cy, 0), 'red', roll=k * math.pi / 4)
        box((0.55, 0.55, 0.5), (0, cy, 0), 'slate')
    strut((-7.4, 2.4, 0), (-1.0, cy + 1.1, 0), 0.12, ROPE)                     # the cable from the drum
    strut((1.45, cy, 0), (1.45, 2.95, 0), 0.12, ROPE)                           # and down to the cage
    box((1.0, 1.1, 1.0), (1.45, 2.4, 0), 'slate')                                # the cage, over the carts
    hut(3.6, 2.6, 3.4, (-8.8, 0, 0), TIMBER, 'slate')                            # the hoist house
    box((0.45, 1.8, 0.45), (-9.9, 3.8, 1.0), 'slate')
    for s in (-1, 1):                                                            # a ladder up a leg, clear of the carts
        box((0.1, 6.0, 0.1), (1.9, 3.0, -1.2 + s * 0.25), TIMBER)
    for i in range(7):
        box((0.1, 0.08, 0.5), (1.9, 0.6 + i * 0.8, -1.2), TIMBER)
    kit('pirate', 'barrel', (-2.6, 0, 2.6), yaw=0.3, scale=0.5)

@piece(1.45)
def ore_line():
    # Gulch: the mine's narrow-gauge line, placed on the mine portal's own
    # anchor (this frame and grow are the portal's). It branches off the
    # portal's line just outside the adit, winds out of the yard along the
    # start straight and round the east bend, and ends at the headframe's
    # collar (placed to meet it). Its SET_GROUND is the cutting it lies in, one
    # plain per chord of the route; the rails run on a smooth curve through the
    # chords' ends, the portal's gauge and sleepers. Two carts of gold ore ride
    # it (anim_path, facing their way): out of the dark of the adit, the length
    # of the line, onto the collar and down the shaft, home under the ground.
    # Cut in three runs (groups), so a cell draws only the runs it sees.
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
        n = max(1, math.ceil(math.dist(p1, p2) / 0.5))
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
    RAIL, TIE = 2.8, 1.6                                         # a rail chord, the sleepers' spacing
    nr = max(3, math.ceil(total / RAIL))
    ss = [total * i / nr for i in range(nr + 1)]
    for run in range(3):
        before = set(bpy.context.scene.objects)
        i0, i1 = nr * run // 3, nr * (run + 1) // 3
        for i in range(i0, i1):
            (pa, da), (pb, db) = on(ss[i]), on(ss[i + 1])
            for sd in (-1, 1):
                strut((pa[0] + da[1] * 0.55 * sd, 0.12, pa[1] - da[0] * 0.55 * sd),
                      (pb[0] + db[1] * 0.55 * sd, 0.12, pb[1] - db[0] * 0.55 * sd), 0.14, 'slate')
        s = ss[i0] + TIE / 2
        while s < ss[i1]:
            p, d = on(s)
            box((1.6, 0.1, 0.3), (p[0], 0.04, p[1]), TIMBER, yaw=math.atan2(d[0], d[1]))
            s += TIE
        group([o for o in bpy.context.scene.objects if o not in before and o.type == 'MESH'], 'line%d' % run)
    # the carts' loop: up out of the ground behind the adit, out along the
    # portal's line, the length of this one, onto the collar (1.83 on from the
    # line's end, the headframe being placed 2.83 on, its collar 1.0 back) and
    # down the shaft, then home under everything
    loop = [(-6.5, -2.4, 0.0), (-5.0, 0.12, 0.0)]
    loop += [(p[0], 0.12, p[1]) for p in (on(s)[0] for s in ss)]
    (ex, ez), (dx, dz) = on(total)
    loop += [(ex + dx * 1.83, 0.45, ez + dz * 1.83), (ex + dx * 2.3, -3.0, ez + dz * 2.3)]
    for i, p in enumerate(loop):
        marker('path_ore_%d' % i, p)
    x0, z0 = pts[0]
    for n in range(2):
        with animated('anim_path:c=ore:p=48:o=%.1f:f=1#%d' % (n / 2, n), (x0, 0.12, z0)):
            ore_cart((x0, 0.12, z0), yaw=math.pi / 2, ore_color='yellow')

@piece(1.0)
def sauropod():
    # Crag: a giant sauropod's skeleton weathering out of the crag's flank
    # (the piece's SET_GROUND mound: its summit behind, -X, its long face
    # toward the road). The backbone lies along the slope from the tip of the
    # tail to the small skull at the end of the long neck, which climbs the
    # slope; the ribs arch up out of the rock over the chest and down into it
    # again on the downhill side, open to the road; the hip plate and two leg
    # bones lie loose below. Still: it is a fossil. World units (no grow).
    H = set_ground('sauropod')
    BC = 'cream'
    def spine(f):                                                                # f: 0 the tail tip .. 1 the skull
        z = -25.0 + 48.0 * f
        x = -5.0 + 1.4 * math.sin(f * 4.0) - 7.0 * max(0.0, (f - 0.62) / 0.38) ** 1.6
        return x, z
    nv = 30
    for i in range(nv):
        f = i / (nv - 1)
        x, z = spine(f)
        body = math.sin(min(1.0, max(0.0, (f - 0.08) / 0.62)) * math.pi)
        neck = max(0.0, (f - 0.62) / 0.38)
        sz = 0.55 + 1.15 * body + 0.25 * neck
        y = H(x, z) + sz * 0.3
        x2, z2 = spine(min(1.0, f + 0.02))
        x1, z1 = spine(max(0.0, f - 0.02))
        yaw = math.atan2(x2 - x1, z2 - z1)
        box((sz * 1.1, sz * 0.9, sz * 0.8), (x, y, z), BC, yaw=yaw)
        if 0.16 < f < 0.66 and i % 2 == 0:                                       # the spines on the back
            box((sz * 0.3, sz * 0.9, sz * 0.4), (x, y + sz * 0.8, z), BC, yaw=yaw)
    for k in range(9):                                                           # the ribs, open to the road
        # each springs from the backbone, arches over toward the road and
        # sweeps back toward the tail as it goes down into the rock, as a
        # rib does: bowed and raked, so a row of them reads as a ribcage
        f = 0.29 + 0.31 * k / 8
        x, z = spine(f)
        g = 0.55 + 0.45 * math.sin((k + 1) / 10 * math.pi)
        y0 = H(x, z) + 0.9
        pts = [(x, y0, z)]
        for t, (ox, oy, oz) in ((0.33, (1.7, 2.5, -0.5)), (0.66, (3.9, 2.3, -1.3)), (1.0, (5.2, 0.0, -2.0))):
            px, pz = x + ox * g, z + oz * g
            py = y0 + oy * g if t < 1.0 else H(px, pz) - 0.4
            pts.append((px, py, pz))
        for p0, p1 in zip(pts, pts[1:]):
            strut(p0, p1, 0.42, BC)
    x, z = spine(1.0)                                                            # the skull
    y = H(x, z) + 0.6
    box((1.7, 1.2, 2.3), (x, y + 0.3, z + 0.7), BC)
    box((1.3, 0.55, 1.5), (x, y - 0.1, z + 1.9), BC)
    for sd in (-1, 1):
        box((0.14, 0.5, 0.6), (x + sd * 0.82, y + 0.5, z + 0.4), 'dark')
    x, z = spine(0.3)                                                            # the hip plate, the legs
    hx = x + 2.2
    box((2.6, 0.4, 3.0), (hx, H(hx, z) + 0.1, z - 0.5), BC, yaw=0.3, roll=0.35)
    for (a, b, t) in (((x + 3.6, z - 3.5), (x + 6.6, z + 0.5), 0.62), ((x + 5.4, z + 3.0), (x + 8.0, z + 6.0), 0.5)):
        ya, yb = H(*a) + t * 0.4, H(*b) + t * 0.4
        strut((a[0], ya, a[1]), (b[0], yb, b[1]), t, BC)
        box((t * 2.0, t * 1.4, t * 1.6), (b[0], yb + 0.1, b[1]), BC)              # its knuckle
    x, z = spine(0.6)
    for k, (dx, dz, kk) in enumerate(((6.5, -1.0, 1.4), (8.0, 4.5, 1.0), (4.0, 9.0, 1.2))):
        sandstone_rock((x + dx, H(x + dx, z + dz) - 0.3, z + dz), kk, yaw=0.7 * k, color=0xa96545)

@piece(1.45)
def dino_dig():
    # Crag: the palaeontologists' camp below the crag, where one of the
    # skeleton's legs turned up: a pit pegged out with string round a huge
    # thigh bone, a sieve on its trestles, crates of plaster jackets, a canvas
    # tent, its flag flapping (anim_sway).
    box((5.4, 0.06, 3.4), (0, 0.03, 0), 'brown')                                  # the dug floor
    box((0.7, 0.6, 3.6), (0.2, 0.36, 0), 'cream', yaw=0.25)                        # the thigh bone
    for s in (-1, 1):
        box((1.2, 0.8, 0.9), (0.2 + s * 1.7 * math.sin(0.25), 0.42, s * 1.7 * math.cos(0.25)), 'cream', yaw=0.25)
    stakes = [(-2.9, -1.9), (2.9, -1.9), (2.9, 1.9), (-2.9, 1.9)]
    for x, z in stakes:
        box((0.2, 1.0, 0.2), (x, 0.5, z), 'tan')
    for (x0, z0), (x1, z1) in zip(stakes, stakes[1:] + stakes[:1]):
        if x0 == x1:
            box((0.08, 0.08, abs(z1 - z0)), (x0, 0.85, (z0 + z1) / 2), 'red')
        else:
            box((abs(x1 - x0), 0.08, 0.08), ((x0 + x1) / 2, 0.85, z0), 'red')
    for s2 in (-1, 1):                                                            # the tent
        box((2.8, 0.12, 1.8), (-4.2, 0.7, -2.6 + s2 * 0.62), 0xf2bf99, pitch=-s2 * 0.86)
    box((3.0, 0.14, 0.14), (-4.2, 1.4, -2.6), ROPE)
    for s in (-1, 1):
        prism([(1.2, 0.02), (-1.2, 0.02), (0, 1.35)], -4.2 + s * 1.35, 0.1, 0xf2bf99)
    flagpole((-6.0, 0, -4.0), 3.4, 'red', w=1.0, fh=0.6, wave='anim_sway:a=z:d=24:p=2.1#1')
    for k, (x, z) in enumerate(((-3.6, 1.6), (-4.4, 2.4), (-3.9, 2.2))):         # crates of plaster jackets
        box((0.9, 0.7, 0.9), (x, 0.35 + (0.7 if k == 2 else 0), z), 0x9a7b55, yaw=0.2 * k)
    for sx in (-1, 1):                                                           # the sieve on trestles
        for sz in (-1, 1):
            box((0.12, 0.9, 0.12), (3.8 + sx * 0.6, 0.45, 2.8 + sz * 0.4), TIMBER)
    box((1.5, 0.12, 1.1), (3.8, 0.95, 2.8), 'slate')
    kit('survival', 'tool-pickaxe', (2.2, 0, -2.8), yaw=1.2, scale=3.0, roll=0.25)
    kit('survival', 'bucket', (-1.8, 0, 2.6), yaw=0.4, scale=2.6)

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
