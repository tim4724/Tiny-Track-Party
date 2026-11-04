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
import contextlib
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

def cyl(r, h, at, color, r2=None, segs=8, axis='up', yaw=0.0, smooth=False, stem=False):
    """A cylinder (or cone when r2 differs) whose base centre is `at`, standing
    along `axis` (up | along | across). Faceted, like a Kenney barrel; a thin
    one longer than four radii is a pole, built as the cars' square bar (a log
    or a trunk stays round: `stem`, a living thing's round body)."""
    pole = h > 4 * r and r <= 0.25 and not stem
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
# `tilt` leans a part's node about x (a spinning top's axis, off upright, for
# it to precess round the upright spin of the part it rides): build its
# pieces upright and the block leans them, its riders' too, about the pivot.

ANIMS = []
ANIM_STACK = []

def animate(objs, name, pivot, yaw=0.0):
    """Mark built objects as one moving part (what `animated` does for a block)."""
    gid = len(ANIMS)
    ANIMS.append((name, pivot, yaw, None, 0.0))
    for o in objs:
        o['anim'] = gid

class animated:
    def __init__(self, name, pivot, yaw=0.0, tilt=0.0):
        self.name, self.pivot, self.yaw, self.tilt = name, pivot, yaw, tilt
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        self.gid = len(ANIMS)
        ANIMS.append((self.name, self.pivot, self.yaw, ANIM_STACK[-1] if ANIM_STACK else None, self.tilt))
        ANIM_STACK.append(self.gid)
        return self
    def __exit__(self, *exc):
        ANIM_STACK.pop()
        new = [o for o in bpy.context.scene.objects if o not in self.before]
        for o in new:
            if o.get('anim') is None:   # an inner part keeps its own
                o['anim'] = self.gid
        if self.tilt:
            bpy.context.view_layer.update()   # the newest part's matrix_world is not current yet
            lean = Matrix.Translation(P(*self.pivot)) @ Matrix.Rotation(self.tilt, 4, 'X') \
                @ Matrix.Translation(-P(*self.pivot))
            for o in new:
                if o.parent is None:
                    o.matrix_world = lean @ o.matrix_world
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
    for gid, (name, pivot, yaw, _, tilt) in enumerate(ANIMS):
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
        if yaw or tilt:   # the turn moves from the vertices onto the node (yaw about up = Blender Z)
            o.data.transform((Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'X')).inverted())
            o.rotation_euler = (tilt, 0.0, yaw)
        o.name = name
        o.data.name = name
        joined[gid] = o
    bpy.context.view_layer.update()
    for gid, (_, _, _, parent, _) in enumerate(ANIMS):
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
    """A snowy pine: three faceted tiers on a stub of trunk, snow lying on
    the upper part of each tier as it lies on the ambient pines round it (a
    bare green pine beside them read as another season). The snow is a shell
    just outside the tier from a third of its height up, so it shows as a
    white band above each green skirt, as on the Holiday Kit pines, and the
    top tier's is the white tip; a cone set inside the tier showed as a
    hairline."""
    x, y, z = at
    box((0.3 * k, 0.5 * k, 0.3 * k), (x, y + 0.25 * k, z), 0x7a5a3a)
    F, S = 0.32, 1.07                       # where the snow starts up a tier; how far proud
    for i, (r, h) in enumerate(((0.75, 0.7), (0.58, 0.6), (0.4, 0.5))):
        y0 = y + (0.4 + i * 0.42) * k
        cyl(r * k, h * k, (x, y0, z), 0x61cb8b, r2=0.08 * k, segs=6)
        snowy(cyl(S * (r - (r - 0.08) * F) * k, (1 - F) * h * k, (x, y0 + F * h * k, z), 0xf3f7fb,
                  r2=S * 0.08 * k, segs=6), 0.45)

def rock(at, k=1.0, yaw=0.0, color=0x868ba1):
    """A grey rock: two blocks, one tipped on the other."""
    x, y, z = at
    box((1.2 * k, 0.8 * k, 1.0 * k), (x, y + 0.4 * k, z), color, yaw=yaw)
    box((0.7 * k, 0.5 * k, 0.6 * k), (x + 0.2 * k, y + 0.95 * k, z - 0.1 * k), 0x9aa1b4, yaw=yaw + 0.6)

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

class square:
    """Blocks built inside stay square: a small thing far out (a swimmer's
    head) would pay a chamfer's triangles for an edge no racer resolves."""
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        return self
    def __exit__(self, *exc):
        for o in bpy.context.scene.objects:
            if o not in self.before:
                o['chamfer'] = 0

class moved:
    """What is built inside, its moving parts and their path markers too,
    built about the origin and shifted to (x, z): one scene's group laid out
    beside another in the same piece."""
    def __init__(self, x, z):
        self.x, self.z = x, z
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        self.anims = len(ANIMS)
        return self
    def __exit__(self, *exc):
        shift = P(self.x, 0.0, self.z)
        for o in bpy.context.scene.objects:
            if o not in self.before and o.parent is None:
                o.location += shift
        for i in range(self.anims, len(ANIMS)):
            name, (px, py, pz), yaw, parent, tilt = ANIMS[i]
            ANIMS[i] = (name, (px + self.x, py, pz + self.z), yaw, parent, tilt)
        return False

SEA = 0.12   # the sea's surface over the sand a piece in it stands on (buildWater's WATER_LIFT)

def stadium(cx, cz, r, half, n):
    """A closed loop of (x, z) like a running track: two straights along Z
    `half` either side of cz, `r` either side of cx, joined by half circles
    of `n` steps, starting at the +X straight's far end."""
    pts = []
    for zc, a0 in ((cz + half, 0.0), (cz - half, math.pi)):
        pts += [(cx + r * math.cos(a0 + math.pi * i / n), zc + r * math.sin(a0 + math.pi * i / n)) for i in range(n)]
    return pts

def wave(at, L):
    """A breaking wave rolling in to -X from `at` (its foot on the sand, the
    sea's surface SEA over it): a ridge of water `L` long along Z, gentle at
    its back, its crest and steep face white with foam, dying away at both
    ends."""
    x0, y0, z0 = at
    back = [(-0.75, -0.08), (-0.35, 0.06), (-0.05, 0.19)]          # (x, y over SEA): the swell's back
    front = [(-0.05, 0.19), (0.08, 0.21), (0.16, 0.12), (0.26, -0.08)]   # the crest and the face, -X is in
    rows = [(-0.5, 0.1), (-0.2, 0.95), (0.2, 0.95), (0.5, 0.1)]
    for prof, color in ((back, 'sky'), (front, 0xfff6eb)):
        n = len(prof)
        verts = [(x0 - x, y0 + SEA - 0.08 + (y + 0.08) * h, z0 + f * L) for f, h in rows for x, y in prof]
        faces = [(j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i)
                 for j in range(len(rows) - 1) for i in range(n - 1)]
        poly(verts, faces, color)

def flames(tongues, heart, at=(0.0, 0.0, 0.0)):
    """A camp fire's flames: orange tongues round a yellow heart, each
    (dx, dz, r, h, lift, beat) a cone that flickers up and down on its own
    short beat (anim_bob, out of step with the others), so the tips dance
    while the fire as a whole stands still. Each foot is sunk `lift` under
    the embers at `at`, so a tongue at the top of its flicker shows no gap."""
    x0, y0, z0 = at
    for k, (dx, dz, r, h, lift, beat) in enumerate(tongues + (heart,)):
        with animated('anim_bob:h=%.3f:p=%.2f#flame%d' % (lift, beat, k), (x0 + dx, y0, z0 + dz)):
            cyl(r, h + lift, (x0 + dx, y0 + 0.03 - lift, z0 + dz),
                0xffc044 if k == len(tongues) else 0xff7e44, r2=0.01, segs=5)

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
    # bucket crouched at the near shore, a parent crouched beside, a gull on
    # the far shore and one riding the wind in wide circles over the rocks,
    # which is what a racer this far off sees move.
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
    ka = -0.35
    figure((math.cos(ka) * 6.5, 0.0, math.sin(ka) * 6.5), math.pi - ka, shirt=0xffc044, legs=0x6794d9,
           pose='crouch')
    box((0.08, 0.09, 0.08), (math.cos(ka) * 6.5, 0.045, math.sin(ka) * 6.5 + 0.17), 0xff5040)   # the bucket
    figure((math.cos(0.05) * 6.4, 0.0, math.sin(0.05) * 6.4), math.pi, shirt=0x339cf2, legs=0x38383d, pose='crouch')
    box((0.3, 0.05, 0.18), (math.cos(0.05) * 6.75, 0.03, math.sin(0.05) * 6.75 + 0.3), 0xff7e44)   # a towel
    gull((math.cos(0.95) * 6.5, 0.0, math.sin(0.95) * 6.5), 0.0)                 # on the far shore
    # the gull aloft: wings out, gliding a wide circle from the pool out over
    # the beach toward the road and rising and sinking on the air (a closed
    # path, facing its way). Its rest pose stands on the shore by the other;
    # the path is where it flies.
    ring = [(6.0 + 7.0 * math.cos(i * math.pi / 8), 3.6, 1.0 + 7.0 * math.sin(i * math.pi / 8)) for i in range(16)]
    for i, at in enumerate(ring):
        marker('path_soar_%d' % i, at)
    gx, gz = math.cos(1.25) * 6.5, math.sin(1.25) * 6.5
    with animated('anim_path:c=soar:p=22:f=1+bob:h=0.5:p=5.5#soar', (gx, 0.1, gz)):
        box((0.2, 0.07, 0.08), (gx, 0.1, gz), 0xf8f8fb)                          # body, bill to +X
        box((0.07, 0.06, 0.065), (gx + 0.12, 0.13, gz), 0xf8f8fb)
        box((0.06, 0.04, 0.05), (gx + 0.17, 0.12, gz), 0xffc044)
        for sd in (-1, 1):                                                      # wings, a shallow V
            box((0.11, 0.03, 0.26), (gx + 0.01, 0.14, gz + sd * 0.16), 0x9aa1b4, pitch=sd * 0.2)
            box((0.08, 0.03, 0.08), (gx, 0.17, gz + sd * 0.32), 0x38383d, pitch=sd * 0.2)
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
    # blue net loft with its door to the road (+X) and floats hung on its
    # wall, the boat hauled up beside it with its pale sail hung up its mast to
    # dry (what a racer sees first, over the kerb; not the roof's red, which
    # it stands in front of from the road), creels stacked high by the slip, a
    # net drying on two poles, and the fisher in yellow oilskins sorting the
    # catch, who turns to watch the cars go by.
    hut(1.5, 1.0, 1.6, (-0.8, 0, 0), 0x6794d9, 0xcf534f, t=0.25)
    for z in (-0.45, -0.1, 0.25):
        box((0.13, 0.13, 0.07), (-0.8 + z, 0.55, 0.84), 0xff7e44)            # floats on the wall
    bx, bz = 0.75, -1.75
    boat((bx, 0, bz), 0.25, 0xfff6eb, trim=0x339cf2)
    box((0.07, 1.35, 0.07), (bx, 0.75, bz), 0x9a7b55)                         # the mast
    sail = [(bz - 0.75, 0.42), (bz - 0.05, 1.38), (bz - 0.05, 0.35)]
    prism([(z, y) for z, y in sail], bx + 0.02, 0.03, 0xfff6eb)               # the sail, hung up to dry
    for (x, y, z, yw) in ((0.45, 0, 0.95, 0.1), (0.45, 0, 1.35, -0.05), (0.75, 0, 1.15, 0.4),
                          (0.45, 0.2, 1.15, 0.2), (0.6, 0.4, 1.15, -0.1), (0.5, 0.2, 1.4, 0.3),
                          (0.55, 0.6, 1.2, 0.15)):
        creel((x, y, z), yw)
    for z in (1.9, 2.9):
        box((0.06, 0.8, 0.06), (-0.2, 0.4, z), 0x9a7b55)
    box((0.03, 0.42, 0.98), (-0.2, 0.52, 2.4), 'slate')                     # the net
    box((0.05, 0.05, 1.06), (-0.2, 0.78, 2.4), 0x9a7b55)
    with animated('anim_watch:r=22:d=70#fisher', (1.05, 0, 0.55)):
        figure((1.05, 0, 0.55), 0.0, shirt=0xffc044, legs=0x38383d, hair=0x38383d)
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
    flames(((0.03, 0.0, 0.1, 0.22, 0.04, 0.33), (-0.04, 0.03, 0.08, 0.17, 0.035, 0.29)),
           (0.01, -0.01, 0.06, 0.28, 0.05, 0.24), at=(1.2, 0.0, 0.4))
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
    kit_flag('flag-pirate-high', (-0.45, 0, 0.9), math.radians(90), 0.6,    # cloth to the road, it flaps
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
            tube([(s * 0.06, 0.1, z), (s * 0.8 * w, 0.24, z), (s * 1.15 * w, 0.85, z),
                  (s * 1.22 * w, 0.85 + 0.8 * hh, z)], 0.08, wood, res=3, wire=True)
    # what is left of the planking, along the low side, still nearly whole
    # there, so the hull shows from the road as a hull and not a comb
    for y, x, z0, z1 in ((0.32, 0.95, -3.4, 2.9), (0.55, 1.1, -3.2, 2.5), (0.78, 1.15, -2.9, 1.9),
                         (1.01, 1.18, -2.5, 1.2), (1.24, 1.2, -2.0, 0.5), (1.47, 1.22, -1.4, -0.2)):
        box((0.07, 0.22, z1 - z0), (-x, y, (z0 + z1) / 2), wood)
    for y, z0, z1 in ((0.32, -3.0, 0.4), (0.55, -2.6, -0.4), (0.78, -2.0, -1.0)):
        box((0.07, 0.22, z1 - z0), (1.0 + (y - 0.32) * 0.2, y, (z0 + z1) / 2), wood)
    # the mainmast still standing, snapped two thirds up, its yard hanging
    # off it askew: the wreck's one tall line, what a racer sees coming
    rod((0.0, 0.1, 0.4), (0.12, 2.3, 0.45), 0.13, wood, r2=0.1, segs=6)
    rod((0.12, 2.3, 0.45), (0.2, 2.55, 0.42), 0.1, wood, r2=0.03, segs=5)
    beam((-0.9, 1.55, 0.2), (1.0, 2.0, 0.65), 0.09, wood)                          # its yard
    beam((0.6, 0.12, 0.6), (3.0, 0.15, -1.3), 0.13, wood)                          # the topmast, down
    gull((0.2, 2.55, 0.42), 0.8)                                               # on the stump
    join_still('wreck')

@piece(1.0)
def jetty():
    # Cove: the pirates' landing stage at a car's scale, from the sand (+X)
    # out over the shallows (-X) toward the ship: plank decking a little wider
    # than a car, high on square piles (a pier stands well clear of the tide,
    # and a deck at the sand's height lay hidden behind the road's kerb),
    # steps up to it from the beach, a rail along both sides, a rowing boat
    # tied at the far end where a pirate keeps watch under the Jolly Roger,
    # barrels and crates waiting at the near end by the cargo derrick, one
    # slung from its jib over the deck.
    D = 0.7                                                                     # the deck's height
    for k in range(22):                                                         # the decking
        box((0.42, 0.1, 0.8), (1.2 - k * 0.46, D, 0), 0xb06041 if k % 3 else 0x9a6a46)
    for zs in (-0.32, 0.32):                                                    # the stringers
        box((10.2, 0.12, 0.12), (-3.7, D - 0.1, zs), 0x8a6a46)
    for k in range(6):
        for zs in (-0.42, 0.42):
            box((0.14, D + 0.6, 0.14), (1.2 - k * 1.95, (D - 0.6) / 2, zs), 0x8a6a46)
            box((0.09, 0.32, 0.09), (1.2 - k * 1.95, D + 0.2, zs), 0x8a6a46)    # the rail's posts
    for zs in (-0.42, 0.42):                                                    # the rail
        box((9.9, 0.08, 0.08), (-3.7, D + 0.34, zs), 0x9a6a46)
    for i in range(3):                                                          # the steps down to the sand
        box((0.3, 0.08, 0.7), (1.58 + i * 0.28, D - 0.2 - i * 0.22, 0), 0x9a6a46)
        box((0.08, D - 0.2 - i * 0.22, 0.08), (1.58 + i * 0.28, (D - 0.2 - i * 0.22) / 2, 0.3), 0x8a6a46)
    kit('pirate', 'boat-row-small', (-8.2, -0.02, 0.95), yaw=math.radians(90), scale=0.32)
    beam((-8.0, D - 0.1, 0.42), (-8.1, 0.2, 0.75), 0.06, 0xfde4c7)
    figure((-8.5, D + 0.05, 0.0), math.pi, shirt=0xfff6eb, legs=0x38383d, hair=0xcf534f)
    kit('pirate', 'barrel', (2.4, 0, -0.45), yaw=0.4, scale=0.2)
    kit('pirate', 'barrel', (2.55, 0, 0.6), yaw=1.2, scale=0.2)
    kit('pirate', 'crate', (0.7, D + 0.05, 0.15), yaw=0.2, scale=0.25)
    kit('pirate', 'crate', (0.7, D + 0.24, 0.15), yaw=0.6, scale=0.21)
    kit('pirate', 'barrel', (0.95, D + 0.05, -0.2), yaw=0.9, scale=0.2)
    # the cargo derrick at the land end, the Jolly Roger at the jetty head:
    # the landing's tall lines
    box((0.14, 2.3, 0.14), (1.45, 1.15, -0.6), 0x8a6a46)
    beam((1.45, 2.2, -0.6), (0.3, 2.05, -0.15), 0.1, 0x8a6a46)
    beam((1.45, 1.4, -0.6), (0.9, 2.08, -0.4), 0.08, 0x8a6a46)
    box((0.04, 0.5, 0.04), (0.35, 1.8, -0.15), 0xfde4c7)
    kit('pirate', 'barrel', (0.35, 1.32, -0.15), yaw=0.3, scale=0.2)
    kit_flag('flag-pirate-high', (-8.0, D + 0.05, -0.3), math.radians(90), 0.55, 'anim_sway:a=x:d=24:p=2.3')
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
    # few of them piled on the others, a root plate reared up out of each
    # pile, and between them the wrack: weed, a lost float, a broken plank,
    # a crate the sea brought in. Trees are tree-sized here (the beach's own
    # palms stand two to three), so the line reads from the road. It runs
    # along Z, two piles to a piece, their root plates at its two ends: each
    # pile alone is gone from a racer's view as soon as it is near enough to
    # read, so the stretch is one piece that reads from the road the whole
    # way along it.
    wood, pale, dark = 0x8a6a46, 0xb8a686, 0x7a5a3a
    def pile(m, phase):
        """One pile, `m` = -1 mirrors it along Z (its root plate to +Z)."""
        def x_at(z):                       # the line wanders as it goes
            return 0.6 * math.sin(z * 0.45 + phase)
        def at(x, y, z):
            return (x, y, m * z)
        for (z0, z1, dx0, dx1, r, y0, y1, c) in ((-4.8, -1.0, 0.3, -0.4, 0.2, 0.2, 0.17, pale),
                                                (-2.2, 2.4, -0.6, 0.2, 0.24, 0.24, 0.2, wood),
                                                (-1.6, 1.0, 0.5, -0.1, 0.16, 0.5, 0.44, pale),   # piled on the others
                                                (1.6, 4.9, 0.4, -0.3, 0.18, 0.18, 0.15, pale),
                                                (3.0, 4.6, -0.7, 0.5, 0.12, 0.12, 0.12, dark)):
            rod(at(x_at(z0) + dx0, y0, z0), at(x_at(z1) + dx1, y1, z1), r, c, r2=r * 0.7, segs=7)
        # the root plate of the piled tree, reared up out of the line as tall
        # as the great trunk's, its face along the line to a racer coming
        # down it
        rx, ry = x_at(-2.3) - 0.6, 0.85
        cyl(0.85, 0.2, at(rx, ry, -2.3 if m > 0 else -2.1), 0x7a5a3a, segs=9, axis='along')
        for a in (-0.9, 0.3, 1.6, 2.6):
            rod(at(rx + 0.5 * math.cos(a), ry + 0.5 * math.sin(a), -2.2),
                at(rx + 1.05 * math.cos(a), max(0.05, ry + 1.05 * math.sin(a) - 0.2), -1.9),
                0.07, wood, r2=0.03, segs=5)
        # the wrack between the trees
        for z in (-4.0, -0.6, 0.9, 3.4):
            box((0.5, 0.04, 0.24), at(x_at(z) - 0.5, 0.02, z), 0x2f8f5b, yaw=-m * 0.6 * math.sin(z * 1.3))
        for z in (-3.0, 2.0):
            box((0.4, 0.04, 0.2), at(x_at(z) + 0.55, 0.02, z), 0x7a5a3a, yaw=-m * 0.8 * math.cos(z))
        box((0.13, 0.13, 0.13), at(x_at(-0.2) + 0.6, 0.065, -0.2), 0xff7e44)       # a fishing float
        box((0.12, 0.04, 0.75), at(x_at(3.2) + 0.7, 0.02, 3.2), 0x9a6a46, yaw=-m * 0.5)   # a broken plank
        box((0.24, 0.2, 0.3), at(x_at(-3.8) - 0.6, 0.1, -3.8), 0xb06041, yaw=-m * 0.4)   # a crate
    with moved(0.0, -4.9):
        pile(1, 0.0)
    with moved(0.35, 4.9):
        pile(-1, 1.3)
    join_still('strand')

@piece(1.0)
def bonfire():
    # Driftwood: the beach fire at the end of the strand line, at a car's
    # scale: driftwood stood up in a cone in its ring of stones, the flames
    # flickering up out of it, its smoke going up over the beach; two logs
    # drawn up as seats with three of the beach's people round it, and a
    # lean-to of driftwood poles behind them out of the wind.
    for k in range(8):
        a = k / 8 * 2 * math.pi
        box((0.1, 0.08, 0.08), (math.cos(a) * 0.32, 0.04, math.sin(a) * 0.32), 0x868ba1, yaw=-a)
    disc(0.27, (0, 0.0, 0), 0x38383d, segs=10, h=0.03)
    flames(((0.05, 0.0, 0.13, 0.34, 0.05, 0.31), (-0.07, 0.06, 0.1, 0.27, 0.045, 0.37),
            (-0.03, -0.08, 0.09, 0.23, 0.04, 0.27)), (0.01, 0.01, 0.07, 0.44, 0.06, 0.23))
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
    R, B = 1.35, 0.95                                    # the ridge's height, how far back the poles reach
    for z in (-0.8, 0.8):
        rod((-1.25, 0, z), (-1.25, R, z), 0.06, 0xb8a686, segs=5)
    rod((-1.25, R, -0.95), (-1.25, R, 0.95), 0.06, 0xb8a686, segs=5)
    for i in range(8):
        z = -0.8 + i * 0.23
        rod((-1.25, R, z), (-1.25 - B, 0.0, z + 0.05 * (i % 2)), 0.06, 0x8a6a46 if i % 2 else 0xb8a686, segs=5)
    # an old sail over the poles: without it the frame reads as a swing
    box((math.hypot(R, B) - 0.05, 0.03, 1.9), (-1.25 - B / 2 - 0.03, R / 2 + 0.03, 0.0), 0x6794d9,
        roll=math.atan2(R, B))
    marker('anim_smoke', (0.0, 0.5, 0.0))
    join_still('fire')

# ---- Riptide ----

# Where along the beach the swim line's middle lies off the tower: up the
# beach toward the cars coming (-Z), because past the tower (+Z) Riptide's
# shore bay ends and the line's far end would lie on the sand.
SWIM_Z = -7.5

@piece(1.0)
def lifeguard_tower():
    # Riptide: the surf patrol's station on the beach by the waterline, at a
    # car's scale: a white hut on stilts a car's height up, its lookout window
    # to the sea (+X), the ramp down its back toward the road, a red roof
    # under the patrol's flag and a red cross for the road to see. Round it:
    # the rescue board and the ring buoy, a rack of surfboards, the red rescue
    # boat pulled up toward the water, and the red-and-yellow flags that mark
    # where to swim. The lifeguard on the deck watches the water through
    # binoculars and turns them on the cars going by; the flags fly.
    # The patrol's whole beach is this one piece: the swimmers' umbrellas
    # either side of the tower and the swim line and the surf off it. Each of
    # them alone is a car's size, a speck from the road; together, close round
    # the tower, they read as one beach for as long as the tower does.
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
    # the lifeguard out on the deck beside the hut, on the side the cars come
    # from so they see him past it, binoculars up to the water; he turns them
    # on the cars as they come by (watch)
    gx, gy, gz = 0.5, top + 0.07, -0.5
    def guard():
        figure((gx, gy, gz), 0.0, shirt=red, legs=red, hair=0xffc044)
        for s in (-1, 1):                                                  # forearms up to them
            beam((gx + 0.02, gy + 0.32, gz + s * 0.1), (gx + 0.08, gy + 0.42, gz + s * 0.05), 0.06, red)
        box((0.07, 0.06, 0.14), (gx + 0.1, gy + 0.43, gz), 0x38383d)          # the binoculars
    with animated('anim_watch:r=20:d=100#guard', (gx, gy, gz)):
        guard()
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
    # the swimming flags either side of the patrol's water (the swim line's
    # middle, SWIM_Z below)
    for k, z in enumerate((SWIM_Z - 2.3, SWIM_Z + 2.6)):
        flag_on_pole((1.1, 0, z), 1.0, (red, 0xffc044), 'anim_sway:a=z:d=24:p=%.1f#swim%d' % (2.0 + 0.3 * k, k))
    # Each group stands still as a part of its own, so a cell that sees only
    # the tower or only the water draws only that.
    def still(name, build, x, z):
        before = set(bpy.context.scene.objects)
        with moved(x, z):
            build()
        group([o for o in bpy.context.scene.objects if o not in before and o.type == 'MESH'
               and o.get('anim') is None], name)
    # Square blocks on the beach and the water: a sunbather's, a float's or a
    # deck chair's rounded edge is under a pixel from the road, and they cost
    # the vista frame's vertices.
    def beach(tag):
        with square():
            swimmers_beach(tag)
    still('beach_a', lambda: beach('a'), 0.0, -6.0)
    still('beach_b', lambda: beach('b'), 0.0, 6.0)
    def swim():
        with square():
            swim_line()
    still('swim', swim, 12.0, SWIM_Z)
    group([o for o in bpy.context.scene.objects
           if o.type == 'MESH' and o.get('anim') is None and o.get('group') is None], 'tower')

def swimmers_beach(tag):
    # Riptide: the swimmers' stretch of beach by the patrol, at a car's scale:
    # striped umbrellas a little over a car's height in a loose row along the
    # sand, a towel under each with its sunbather, deck chairs turned to the
    # sea (+X), a cool box, a sandcastle, and two children by the water
    # throwing a beach ball between them.
    for (x, z, c) in ((0.1, -2.6, 0xff5040), (-0.3, -1.3, 0x339cf2), (0.2, 0.1, 0xffc044),
                      (-0.2, 1.4, 0xff5040), (0.15, 2.7, 0x22c46e)):
        umbrella((x, 0, z), 0.42, 0.68, (c, 0xfff6eb))
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
    figure((1.25, 0, -1.2), -math.pi / 2, shirt=0xffc044, legs=0x339cf2)
    figure((1.25, 0, 0.0), math.pi / 2, shirt=0x61cb8b, legs=0xff5040, hair=0x38383d)
    # the ball lobbed from one child's hands to the other's and back, turning
    # over in the air (anim_path along the arc and back: it turns round in
    # their hands)
    arc = [(1.25, 0.36 + 0.55 * (1 - (2 * t - 1) ** 2), -1.08 + 0.96 * t) for t in (i / 8 for i in range(9))]
    for k, at in enumerate(arc + arc[-2:0:-1]):
        marker('path_ball%s_%d' % (tag, k), at)
    with animated('anim_path:c=ball%s:p=2.4:f=0+spin:a=x:w=5' % tag, arc[0]):
        box((0.1, 0.1, 0.1), arc[0], 0xff5040)
        box((0.11, 0.03, 0.11), arc[0], 0xfff6eb)                              # its white band

def swim_line():
    # Riptide: the swimming line off the patrol's beach, at a car's scale: a
    # rope of red and white floats lying on the water between two marker
    # buoys, each flying a flag, swimmers inside it, and out past it the
    # surf. The swell lifts it all: the markers rock and bob, the line rides
    # up and down in two lengths, out of step, the swimmers' heads ride it,
    # a surfer sits her board waiting; the lifeguard paddles a rescue board
    # round the swimmers, and either side of the flags a wave rolls in with
    # a surfer riding it. The sea is the ground's (+X out to sea, the water
    # SEA over the sand at 0); what moves rides on it, so no figure stands.
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
            for k in range(7):                        # each float down through the water to the sand
                zf = z0 + 0.5 + k * 2.2
                box((0.12, 0.24, 0.16), (0, 0.12, zf), 0xfff6eb if (g * 7 + k) % 2 else 0xff5040)
    def board(x, z, color, yaw, y=None):
        """A surfboard along +Z turned by `yaw`: lying on the water at `y`
        (a ridden one), else its keel down through the water to the sand."""
        c, s = math.cos(yaw), math.sin(yaw)
        t, cy = (0.06, y) if y is not None else (0.17, 0.085)
        box((0.13, t, 0.5), (x, cy, z), color, yaw=yaw)
        box((0.09, t, 0.12), (x + 0.25 * s, cy, z + 0.25 * c), color, yaw=yaw + math.pi / 4)
    with animated('anim_bob:h=0.08:p=3.4#sit', (5.0, 0.14, 0.0)):
        board(5.0, 0.0, 0xffc044, 0.3)
        figure((5.0, 0.17, -0.05), -1.3, shirt=0x38383d, legs=0x38383d, hair=0xffc044, pose='sit')
    # swimmers between the flags, in the white water inside the line: heads
    # and shoulders out of it, riding the swell (a pair together, one alone)
    for k, (heads, lift, beat) in enumerate(((((-2.8, -1.2, 0xffc044), (-2.6, -0.85, 0x339cf2)), 0.05, 2.9),
                                             (((-2.4, 1.4, 0xff5040),), 0.06, 3.3))):
        with animated('anim_bob:h=%.2f:p=%.1f#swimmer%d' % (lift, beat, k), (heads[0][0], 0.0, heads[0][1])), square():
            for (x, z, cap) in heads:
                box((0.1, 0.1, 0.2), (x, SEA - 0.03, z), 0xf2bf99)            # shoulders, awash
                box((0.11, 0.11, 0.11), (x, SEA + 0.07, z), 0xf2bf99)
                box((0.12, 0.05, 0.12), (x - 0.01, SEA + 0.135, z), cap)       # a swim cap
    # the lifeguard on the rescue board, kneeling, paddling slow laps along
    # the outside of the line off the swimmers (a stadium of two straights,
    # the board bow first), clear of the surf either side
    patrol = stadium(1.4, 0.0, 0.5, 4.5, 6)
    for k, (x, z) in enumerate(patrol):
        marker('path_patrol_%d' % k, (x, SEA - 0.06, z))
    x0, z0 = patrol[0]
    with animated('anim_path:c=patrol:p=40:f=1+bob:h=0.03:p=1.7#rescue', (x0, SEA - 0.06, z0)), square():
        box((0.62, 0.08, 0.16), (x0, SEA - 0.02, z0), 0xff5040)                 # the board, bow to +X
        box((0.16, 0.08, 0.12), (x0 + 0.33, SEA - 0.02, z0), 0xff5040, yaw=math.pi / 4)
        figure((x0 - 0.04, SEA + 0.02, z0), 0.0, shirt=0xff5040, legs=0xff5040, hair=0xffc044, pose='crouch')
        beam((x0 + 0.12, SEA + 0.0, z0 + 0.14), (x0 - 0.02, SEA + 0.36, z0 + 0.1), 0.06, 0x9a7b55)   # the paddle
    # the surf either side of the flags: a wave rolls up out of the swell
    # with a surfer riding it across and in, and short of the line it breaks
    # and pitches him over into the water (a wipeout: he never sinks upright).
    # The wave and its rider are one rigid part on a closed path that faces
    # it along its way (f=2, so the dive tips it forward and the climb tilts
    # it back), its node turned to the ride so the rest pose is the ride's;
    # the way back out runs deep under the sand, where the turns are hidden.
    for k, s in enumerate((-1, 1)):
        d = (-math.sqrt(0.5), -s * math.sqrt(0.5))            # the ride's way, in and across
        x0, z0 = 7.4, s * 12.0
        x1, z1 = 2.6, s * 7.2
        ride = [(x0, 0.0, z0), (x1, 0.0, z1),
                (x1 + 0.8 * d[0], -1.8, z1 + 0.8 * d[1]),    # the dive, 66 degrees down
                (x0 - 3.1 * d[0], -1.8, z0 - 3.1 * d[1])]    # back out; up again at 30 degrees
        for i, at in enumerate(ride):
            marker('path_surf%d_%d' % (k, i), at)
        with animated('anim_path:c=surf%d:p=14:o=%.1f:f=2#surf%d' % (k, 0.5 * k, k), ride[0],
                      yaw=s * 3 * math.pi / 4), square():
            wave(ride[0], 2.8)
            yb = -math.pi / 2 - s * math.pi / 4                # the board along the ride, in and across
            board(x0 - 0.1, z0, (0x339cf2, 0xff5040)[k], yb, y=SEA + 0.14)
            # standing side on, facing in to the beach, arms out
            yf = yb + math.pi
            figure((x0 - 0.1, SEA + 0.17, z0), yf, shirt=(0xff7e44, 0x61cb8b)[k], legs=0x38383d,
                   hair=(0x7a5a3a, 0xffc044)[k])
            c, sn = math.cos(yf), math.sin(yf)
            for side in (-1, 1):
                beam((x0 - 0.1 + side * 0.1 * sn, SEA + 0.52, z0 + side * 0.1 * c),
                     (x0 - 0.1 + side * 0.3 * sn, SEA + 0.44, z0 + side * 0.3 * c), 0.06, 0xf2bf99)

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

def flag_across(at, h, color, wave, w=0.8, fh=0.5, pole=0xfff6eb):
    """A pole `h` tall and its flag flying ACROSS the piece (+Z), so a piece
    facing the road (+X) shows the road the cloth, not its edge; `wave` flaps
    it about its own normal (x), hinged at the top of the pole."""
    x, y, z = at
    box((0.08, h, 0.08), (x, y + h / 2, z), pole)
    with animated(wave, (x, y + h, z)):
        box((0.06, fh, w * 0.55), (x, y + h - fh / 2 - 0.04, z + w * 0.27 + 0.04), color)
        box((0.06, fh * 0.9, w * 0.5), (x + 0.06, y + h - fh / 2 - 0.08, z + w * 0.76), color, yaw=0.3)

def snow_person(x, y, z, coat, hat, yaw=0.0):
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
    column four units tall at most, the sheaves either side at the gauge.
    Painted red, as many resorts paint theirs, and a little stout: grey on
    the shaded snow, the line of towers up the flank was lost from the road."""
    x, _, z = at
    box((0.3, h - ground + 0.5, 0.3), (x, (h + ground - 0.5) / 2, z), 0xcf534f, yaw=yaw)
    box((1.4, 0.16, 0.16), (x, h + 0.08, z), 0xcf534f, yaw=yaw)
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
        snow_person(px, 0, pz, COATS[k + 1], COATS[k + 3], yaw=yaw - math.pi / 2)
    # the resort's chalets round the valley station, on the flat toward the road
    for (lx, lz, w, d, wall, ry) in ((4.5, -3.0, 2.2, 1.6, 0x9a5f3c, 0.3), (5.5, 1.2, 1.8, 1.4, 0xcf534f, -0.2),
                                     (2.6, 4.2, 2.0, 1.5, 0x9a7b55, 0.5)):
        cabin_hut(w, 0.95, d, (V[0] + lx, 0, V[1] + lz), wall, 0xeef4f9, yaw=ry)
    for k in range(2):
        snow_person(V[0] + 3.2 + 0.5 * k, 0, V[1] - 0.6 + 0.9 * (k % 2), COATS[k], COATS[(k + 2) % 6], yaw=1.2 * k)
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
    # skaters (half a unit tall) glide round a rink on the west ice at a
    # skater's pace (anim_path; carried by their skates, they hold their
    # pose); out on the north-west ice a little village of fishing
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
        with animated('anim_path:c=rink:p=26:o=%.3f:f=1#%d' % (n / 6, n), at):
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
    with animated('anim_sway:a=z:d=8:p=2.4#rod', (sx + 0.1, 0.36, sz)):
        box((0.48, 0.03, 0.03), (sx + 0.32, 0.42, sz), 0x2a2735, roll=0.4)
    # on the ice by the rink, a snowman in a hat
    snowman((-7.6, 0.07, 5.0), 0.15, hat=True)

@piece(1.0)
def snow_fort():
    # Glacier: a big snow fort built of blocks laid in courses (the shading
    # tells them apart, the snow on top is rounded over), at a real fort's
    # size beside a car:
    # four units square, walls a unit tall with battlements, the gateway open
    # to the road (+X), a round lookout tower of blocks at the back corner
    # standing well over the walls and flying a big red flag, the builders'
    # pennants on the corners, snowballs piled ready, sleds left by the gate,
    # a snowman keeping watch. The blocks are cut from the glacier's ice, pale
    # blue under the snow lying on the battlements and the tower's crown: a
    # white fort on white snow did not read from the road. Beside it (+Z) the
    # builders' igloo camp, one scene with the fort: the big igloo of cut
    # blocks, a small dome, the dog team resting by their sled.
    SNOW, ICE = 0xf3f7fb, 0x9fd6ee
    H = 2.0                                                        # half a side
    BL, BH, BD = 1.0, 0.45, 0.5                                     # a block: long, high, deep
    def cut(size, at, yaw=0.0, round=True, color=ICE):
        o = snowy(box(size, at, color, yaw=yaw), 0.4)
        if round:                                                  # what the eye reads: the top
            o['round'] = 0.1
    for c in range(2):                                             # two courses, the joints staggered
        y = BH / 2 + c * BH
        for k in range(4):
            t = -H + BL / 2 + k * BL + (BL / 2 if c % 2 else 0.0)
            if t > H - 0.3:
                continue
            if abs(t) > 0.6:
                cut((BD, BH, BL), (H, y, t), round=False)          # the front wall, the gate left open
            cut((BD, BH, BL), (-H, y, t), round=False)             # the back wall
            for sz in (-1, 1):
                cut((BL, BH, BD), (t, y, sz * H), round=False)     # the side walls
    for sx in (-1, 1):                                             # the corners
        for sz in (-1, 1):
            cut((BD, 2 * BH, BD), (sx * H, BH, sz * H), round=False)
    for t in (-1.0, 1.0):                                          # battlements, snow lying on them
        cut((BD, 0.3, 0.5), (-H, 2 * BH + 0.15, t), color=SNOW)
        for sz in (-1, 1):
            cut((0.5, 0.3, BD), (t, 2 * BH + 0.15, sz * H), color=SNOW)
    for sz in (-1, 1):
        cut((BD, 0.3, 0.5), (H, 2 * BH + 0.15, sz * 1.3), color=SNOW)
    tx, tz, R, TC = -H, -H, 0.75, 6                                # the lookout tower, six courses
    for c in range(TC):
        n = 5
        for k in range(n):
            a = (k + 0.5 * (c % 2)) / n * 2 * math.pi
            cut((0.4, BH, 0.9), (tx + math.cos(a) * R, BH / 2 + c * BH, tz + math.sin(a) * R), yaw=-a,
                round=c == TC - 1, color=SNOW if c == TC - 1 else ICE)
    snowy(cyl(R + 0.25, 0.14, (tx, TC * BH, tz), SNOW, segs=12), 0.4)
    flag_across((tx, TC * BH + 0.14, tz), 1.5, 0xff5040, 'anim_sway:a=x:d=22:p=1.9#flag', w=0.9, fh=0.55)
    with plain_parts():                                            # small things: no chamfer to see
        for (sx, sz, c) in ((1, 1, 0x3f7bd9), (1, -1, 0x61cb8b), (-1, 1, 0xa878e8)):   # pennants on the corners
            x, z = sx * H, sz * H
            box((0.06, 0.8, 0.06), (x, 2 * BH + 0.4, z), 0x9a7b55)
            tri = [(z + 0.02 * sz, 2 * BH + 0.78), (z + 0.02 * sz, 2 * BH + 0.48), (z - 0.5 * sz, 2 * BH + 0.63)]
            prism(tri if sz > 0 else tri[::-1], x, 0.04, c)
        for (x, z) in ((H - 0.9, 0.9), (H + 0.9, -1.4)):              # snowballs: four and one on top
            for dx, dz in ((-0.1, -0.1), (0.1, -0.1), (-0.1, 0.1), (0.1, 0.1)):
                snowy(box((0.17, 0.17, 0.17), (x + dx, 0.085, z + dz), SNOW), 0.4)
            snowy(box((0.17, 0.17, 0.17), (x, 0.24, z), SNOW, yaw=0.6), 0.4)
        snowman((H + 1.0, 0, 1.2), 0.15, hat=True)
        snow_person(H + 0.6, 0, 0.0, 0xcf534f, 0x3f7bd9, yaw=0.3)
        snow_person(H - 0.7, 0, -0.6, 0x3f7bd9, 0xffc044, yaw=2.6)
        snow_person(H - 1.5, 0, 0.9, 0x61cb8b, 0xcf534f, yaw=0.2)
        sled(H + 0.9, 0, -0.55, 0.3, 0xcf534f, L=0.6)                   # left by the gate
        sled(H + 1.3, 0, 0.45, -0.4, 0x3f7bd9, L=0.6)
        igloo_dome(0.3, H + 2.1, 0.75, 0.0)                            # the igloo camp
        igloo_dome(-1.3, H + 3.5, 0.5, -0.5, blocks=False)
        sled(1.9, 0, H + 3.4, 0.2, 0x9a7b55, L=0.7)
        for k in range(3):                                             # the team, lying down
            x, z = 2.05 + (k // 2) * 0.32, H + 2.75 + (k % 2) * 0.28 - 0.2 * (k // 2)
            box((0.24, 0.1, 0.11), (x, 0.06, z), (0x868ba1, 0x38383d, 0xfff6eb)[k], yaw=0.2)
            box((0.09, 0.09, 0.09), (x + 0.14, 0.12, z), (0x868ba1, 0x38383d, 0xfff6eb)[k], yaw=0.2)
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

def helicopter(x, y, z, w=14.0):
    """The mountain rescue's helicopter facing +X at its real size (some
    twelve metres, nearly three cars long): a red cabin with a white band and
    dark glass, the tail boom and fin, skids; its two rotors are parts of
    their own that turn at `w` (anim_spin)."""
    RED, GLASS = 0xcf534f, 0x2f3a4a
    box((1.3, 0.8, 0.85), (x, y + 0.55, z), RED)
    box((1.32, 0.16, 0.87), (x, y + 0.4, z), 0xfff6eb)
    box((0.45, 0.55, 0.75), (x + 0.75, y + 0.62, z), GLASS, roll=-0.2)
    box((1.5, 0.2, 0.2), (x - 1.35, y + 0.78, z), RED)
    box((0.35, 0.55, 0.07), (x - 2.0, y + 1.0, z), RED, roll=0.35)
    for sd in (-1, 1):
        box((1.5, 0.07, 0.07), (x + 0.05, y + 0.04, z + sd * 0.42), 0x555b66)
        for dx in (-0.35, 0.4):
            box((0.06, 0.18, 0.06), (x + dx, y + 0.12, z + sd * 0.42), 0x555b66)
    box((0.14, 0.14, 0.14), (x, y + 1.02, z), 0x555b66)
    with animated('anim_spin:a=y:w=%.1f#rotor' % w, (x, y + 1.12, z)):
        box((3.0, 0.05, 0.16), (x, y + 1.12, z), 0x38383d)
        box((0.16, 0.05, 3.0), (x, y + 1.12, z), 0x38383d)
    with animated('anim_spin:a=z:w=%.1f#tail' % (w * 1.6), (x - 2.05, y + 1.0, z + 0.09)):
        box((0.07, 0.62, 0.05), (x - 2.05, y + 1.0, z + 0.09), 0x38383d)

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
def windsock():
    # Avalanche's patrol post, at its real size beside a car: the avalanche
    # patrol's red hut, a windsock streaming on its mast (one and a half
    # units) and swinging round it as the wind veers off the mountain, a
    # slatted weather screen on legs, a snow stake banded to read the depth,
    # a rescue sled, two of the patrol with their probes by the door, and on
    # its pad beside the post the rescue helicopter, its rotors idling (the
    # windsock is the pad's); the post's radio mast over it all, banded red
    # and white, what reads of the post over the kerb of the raised road.
    cabin_hut(1.5, 0.85, 1.2, (-0.4, 0, -0.6), 0xcf534f, 0xeef4f9)
    disc(1.7, (-1.0, 0, 3.6), 0x868ba1, segs=20, h=0.04)            # the pad, its H
    for dz in (-0.35, 0.35):
        box((0.9, 0.02, 0.14), (-1.0, 0.045, 3.6 + dz), 0xfff6eb)
    box((0.14, 0.02, 0.56), (-1.0, 0.045, 3.6), 0xfff6eb)
    helicopter(-1.0, 0.05, 3.6, w=8.0)
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
    snow_person(0.6, 0, -0.1, 0xff7e44, 0x38383d, yaw=0.4)
    snow_person(0.75, 0, 0.3, 0xff7e44, 0xcf534f, yaw=-0.3)
    MX, MZ, MH = -1.3, -1.7, 3.2                                   # the radio mast behind the hut,
    for i in range(8):                                             # banded, guyed, its aerials
        box((0.1, MH / 8, 0.1), (MX, MH / 8 * (i + 0.5), MZ), 0xff5040 if i % 2 == 0 else 0xfff6eb)
    box((0.7, 0.05, 0.05), (MX, MH - 0.1, MZ), 0x555b66)
    box((0.05, 0.05, 0.5), (MX, MH - 0.3, MZ), 0x555b66)
    for a in (0.9, 3.0, 5.1):
        strut((MX, MH * 0.7, MZ), (MX + 1.4 * math.cos(a), 0.02, MZ + 1.4 * math.sin(a)), 0.025, 0xc8cfdf)
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
    if smoke:                                      # True, or the puffs' size (anim_smoke:s=)
        name = 'anim_smoke' if smoke is True else 'anim_smoke:s=%g' % smoke
        # each cabin's marker its own name: Blender would suffix a repeat
        marker('%s#%d' % (name, round(cz * 10)), (cx - 1.1 * k, ridge + 0.9 * k, cz - 0.75 * k))
    box((0.1 * k, 1.55 * k, 1.1 * k), (cx + W / 2 + 0.06 * k, 0.9 * k, cz - 0.55 * k), 0xfff6eb)
    box((0.1 * k, 1.35 * k, 0.85 * k), (cx + W / 2 + 0.12 * k, 0.82 * k, cz - 0.55 * k), 0x38383d)
    box((0.1 * k, 0.8 * k, 0.8 * k), (cx + W / 2 + 0.06 * k, 1.3 * k, cz + 0.95 * k), 0xfff6eb)
    box((0.1 * k, 0.6 * k, 0.6 * k), (cx + W / 2 + 0.12 * k, 1.3 * k, cz + 0.95 * k), 0xffc044)

@piece(1.0)
def log_cabin():
    # Flurry: a corner of the village below the lake at its real size beside
    # a car: a log cabin two and a half units across and two smaller ones
    # either side of it, their chimneys smoking (the columns stand over the
    # kerb of the raised road where the cabins do not), the woodpile under its
    # lean-to between them, a villager.
    log_cabin_at(0.0, 0.0, 0.58, smoke=1.5)
    log_cabin_at(-0.6, 3.0, 0.42, smoke=True)
    log_cabin_at(-0.4, -3.9, 0.48, smoke=True)
    woodpile(0.2, -2.2, 0.3)
    snow_person(1.8, 0, -0.6, 0x3f7bd9, 0xcf534f, yaw=-0.4)
    join_still('cabins')

# ---- snow companions: small scenes that carry a track's story round its lap ----

def kid_skier(x, y, z, coat, hat, k=0.8):
    """A child on skis toward +X, ski tips together in a snowplough: the
    skis, legs, a coat, a head in a helmet, `k` of a grown skier's size.
    Joined into one moving part by its caller."""
    def b(size, dx, dy, dz, color, yaw=0.0):
        box([q * k for q in size], (x + dx * k, y + dy * k, z + dz * k), color, yaw=yaw)
    for sd in (-1, 1):
        b((0.42, 0.04, 0.07), 0.02, 0.02, sd * 0.09, 0x2a2735, yaw=sd * 0.28)   # the plough
    b((0.1, 0.16, 0.16), 0.0, 0.12, 0, 0x38383d)
    b((0.14, 0.17, 0.18), 0.01, 0.28, 0, coat)
    b((0.1, 0.1, 0.1), 0.02, 0.42, 0, 0xf2bf99)
    b((0.12, 0.07, 0.12), 0.01, 0.5, 0, hat)

@piece(1.0)
def ski_school():
    # Powder: the ski school on its nursery slope by the road, at its real
    # size. The slope is the track's terrain (SET_GROUND: a low hill behind,
    # -X, its gentle face to the road), and on it the school's day goes round:
    # the children ride the magic carpet up the slope standing on their skis,
    # step off at the top and snowplough down in a line through their little
    # slalom, out under the red and blue arch at the bottom and round to the
    # carpet again (one loop, a child's slow pace). At the foot the school's
    # red hut, its skis racked, the instructor watching and two tall feather
    # flags by the road, the colour that says "ski school" from a car going
    # by. All of it lies on the slope as the renderer draws it (draped, the
    # children's loop a `drape` chain) but the hut, which stands level.
    H = set_ground('ski-school')
    COATS = (0xcf534f, 0x3f7bd9, 0x61cb8b, 0xffc044, 0xa878e8, 0xff7e44)
    CZ, C0, C1 = -1.3, 1.0, -7.6                                     # the carpet: its line, foot, head
    GATES = [(-6.4, 2.7), (-4.9, 0.9), (-3.4, 2.7), (-1.9, 0.9), (-0.4, 2.7)]
    AX, AZ = 1.7, 1.9                                                # the arch
    def static():
        for z in (-0.55, 0.55):                                       # the ski rack
            box((0.06, 0.34, 0.06), (2.5, 0.17, z - 2.6), 0x9a7b55)
        box((0.06, 0.06, 1.2), (2.5, 0.31, -2.6), 0x9a7b55)
        for k, c in enumerate((0xff5040, 0x339cf2, 0x22c46e, 0xffc044)):
            z = -3.05 + k * 0.28
            for e in (-0.035, 0.035):
                box((0.06, 0.44, 0.06), (2.56, 0.22, z + e), c, roll=-0.18)
        # the magic carpet: its belt, green rails either side, a step at each end
        n = 9
        xs = [C0 + (C1 - C0) * i / n for i in range(n + 1)]
        verts = [(x, 0.06, CZ + e) for x in xs for e in (-0.24, 0.24)]
        poly(verts, [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(n)], 0x38383d)
        for sd in (-1, 1):
            for xa, xb in zip(xs[:-1], xs[1:]):
                box((abs(xb - xa) + 0.04, 0.14, 0.07), ((xa + xb) / 2, 0.08, CZ + sd * 0.3), 0x61cb8b)
        for x in (C0 + 0.35, C1 - 0.35):
            box((0.5, 0.08, 0.7), (x, 0.04, CZ), 0x868ba1)
        for k, (gx, gz) in enumerate(GATES):                          # the children's slalom
            box((0.05, 0.42, 0.05), (gx, 0.21, gz), 0xfff6eb)
            box((0.03, 0.16, 0.22), (gx, 0.34, gz + 0.11), (0xff7e44, 0x3f7bd9)[k % 2])
        R = 0.8                                                       # the arch, red and blue
        for i in range(7):
            t = (i + 0.5) / 7 * math.pi
            box((0.3, 0.3, R * math.pi / 7 + 0.04), (AX, R * math.sin(t), AZ + R * math.cos(t)),
                (0xff5040, 0x3f7bd9)[i % 2], pitch=t - math.pi / 2)
        for fz in (-0.9, 4.2):                                         # feather flags' poles by the road
            box((0.06, 1.5, 0.06), (3.0, 0.75, fz), 0x555b66)
        snow_person(0.9, 0, 0.6, 0xcf534f, 0xfff6eb, yaw=math.pi)         # the instructor, watching
        snow_heap((-0.2, 0, -4.4), 0.5, yaw=0.6)
    draped('school', static)
    # the hut level on the slope, its floor at the slope's top corner and a
    # stone footing under its front: draped, a house leaned with the hill
    hy = max(H(1.4 + dx, -3.4 + dz) for dx in (-0.7, 0.7) for dz in (-0.55, 0.55))
    box((1.5, 1.2, 1.2), (1.4, hy - 0.6, -3.4), 'grey')
    cabin_hut(1.4, 0.8, 1.1, (1.4, hy, -3.4), 0xcf534f, 0xeef4f9)
    # the feather flags' cloth, swinging round its pole as the wind shifts
    for n, (fz, c) in enumerate(((-0.9, 0xff5040), (4.2, 0x3f7bd9))):
        with animated('anim_drape+sway:a=y:d=18:p=%.1f#flag%d' % (2.3 + 0.4 * n, n), (3.0, 0.95, fz)):
            box((0.04, 1.0, 0.36), (3.0, 0.95, fz + 0.2), c)
            box((0.05, 0.12, 0.2), (3.0, 0.75, fz + 0.2), 0xfff6eb)
    # the children's loop: up the carpet, off at the head, down through the
    # gates, under the arch, round to the carpet's foot
    loop = [(C0 + 0.1, 0.08, CZ), (C1 + 0.2, 0.08, CZ), (C1 - 0.6, 0.02, CZ + 0.8), (C1 - 0.3, 0.02, 2.0)]
    for k, (gx, gz) in enumerate(GATES):
        loop.append((gx, 0.02, gz + (-0.4 if k % 2 == 0 else 0.4)))
    loop += [(AX - 0.7, 0.02, AZ), (AX + 0.5, 0.02, AZ), (2.3, 0.02, 0.4), (C0 + 0.6, 0.02, CZ + 0.15)]
    for k, pt in enumerate(loop):
        marker('path_drapekids_%d' % k, pt)
    for n in range(5):
        at = loop[n]
        with animated('anim_path:c=drapekids:p=44:o=%.3f:f=1#%d' % (n / 5, n), at), plain_parts():
            kid_skier(at[0], at[1], at[2], COATS[n], COATS[(n + 3) % 6])

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
    box((0.22 * u, 0.29 * u, 0.2 * u), at(0, 0.2 * u, 0), 0x2a2735, yaw=yaw)             # body
    box((0.16 * u, 0.13 * u, 0.15 * u), at(0.01 * u, 0.405 * u, 0), 0x2a2735, yaw=yaw)   # head
    with plain_parts():                                  # too thin for a chamfer to show
        box((0.18 * u, 0.06, 0.16 * u), at(0.03 * u, 0.03, 0), 0xff7e44, yaw=yaw)        # feet
        box((0.06, 0.23 * u, 0.16 * u), at(0.1 * u, 0.19 * u, 0), 0xfff6eb, yaw=yaw)     # white front
        box((0.08 * u, 0.06, 0.06), at(0.11 * u, 0.39 * u, 0), 0xff7e44, yaw=yaw)        # beak
        if flippers:
            for sd in (-1, 1):
                box((0.12 * u, 0.18 * u, 0.06), at(0, 0.22 * u, sd * 0.12 * u), 0x2a2735, yaw=yaw,
                    pitch=sd * 0.25)

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
    with plain_parts():                                  # too thin for a chamfer to show
        box((0.06, 0.26 * u, 0.16 * u), at(0.1 * u, 0.17 * u), 0xfff6eb, yaw=yaw)
        box((0.08 * u, 0.06, 0.06), at(0.13 * u, 0.36 * u), 0xff7e44, yaw=yaw)

@piece(1.0)
def penguin_group():
    # Glacier: a rookery of penguins on a snow slope by the ice, at their own
    # size beside a car (under half a unit tall). The slope is the track's
    # terrain (SET_GROUND: a low hill behind, -X, its face to the road), and
    # the crowd stands up its face, row over row, so from a car going by it
    # reads as one crowd rather than a line along the kerb: some three dozen,
    # a few lying on their bellies and a chick or two among them, most facing
    # +X; two at the front are alive where they stand (they rock on their
    # feet, turn to watch a car coming and hop as one passes close), and a
    # pair wanders a loop round the rookery's edge, one behind the other
    # (anim_path facing its way, rocking from foot to foot as it goes). All of
    # it lies on the slope as the renderer draws it (draped, the walkers' loop
    # a `drape` chain). Each placement's yaw turns +X to the racer where the
    # lap reads it best.
    CX, RX, RZ, N = -2.8, 4.5, 4.4, 54
    def crowd():
        for i in range(N):
            # a sunflower spread over an oval, so the crowd is even without a grid
            r, a = math.sqrt((i + 0.5) / N), i * 2.39996
            x, z = CX + RX * r * math.cos(a), RZ * r * math.sin(a)
            if x > 0.6 and abs(z) < 1.0:
                continue                                           # room for the live ones in front
            h = math.sin(i * 12.9898) * 0.5 + 0.5
            yaw = (h - 0.5) * 1.6 + 0.6 * math.sin(i * 3.1)
            if i % 9 == 4:
                with plain_parts():
                    slider_penguin(x, 0, z, 0.4)                   # lying on its belly
            else:
                stood_penguin(x, z, 0.34 if i % 7 == 3 else 0.42 + 0.06 * h, yaw)
        snow_heap((CX - 3.2, 0, 2.6), 0.5, yaw=0.5)
    draped('rookery', crowd)
    for n, (x, z, k, yaw) in enumerate(((1.4, 0.35, 0.46, 0.0), (1.2, -0.45, 0.44, 0.3))):
        with animated('anim_drape+' + PENGUIN[5:] % (n + 1), (x, 0, z), yaw):
            penguin(x, 0, z, k, yaw)
    M = 14
    pts = [(CX + math.cos(a) * (RX + 0.8), 0.0, math.sin(a) * (RZ + 0.7))
           for a in (j / M * 2 * math.pi for j in range(M))]
    for j, pt in enumerate(pts):
        marker('path_drapewalk_%d' % j, pt)
    for k in range(2):
        # built sunk under the snow, pivot and all: the path carries the pivot
        # onto the drawn slope, and at rest no part stands over a capped ground
        at = (pts[k][0], -0.6, pts[k][2])
        with animated('anim_path:c=drapewalk:p=40:o=%.3f:f=1+waddle:d=12:p=0.5#%d' % (k * 0.05, k), at):
            penguin(at[0], at[1], at[2], 0.44, 0.0)

@piece(1.0)
def penguin_chute():
    # Glacier: the colony's toboggan hill. The hill is the track's terrain
    # (SET_GROUND: a snow hill some seven units tall, its summit well back from
    # the road, -X, its long face toward it), and this is what lies on it, at
    # the penguins' own size: the slide worn down that face, a packed-ice
    # groove between two lips of snow, running out across the flat into a
    # hole of open water in the ice by the road (+X). Penguins come over the
    # crest on their bellies, toboggan the length of it and shoot into the
    # water; more climb out of the hole and trudge up the hill's flank in a
    # line, waddling, to go over the top for another go; the rest of the
    # colony stands on the face beside the slide, row over row, watching. Both loops close
    # out of sight (under the hill, under the ice): a slider comes up just
    # behind the crest, a climber goes down behind it, so a racer sees them
    # go in and come out, never jump. Everything is DRAPED: built from y = 0
    # as if on the plain and laid on the terrain as the renderer draws it,
    # the paths too (`drape` chains), so nothing floats off the grid's chords.
    TOP, HOLE = -19.0, 3.0                                            # the summit, the water hole
    def static():
        n = 56                                                        # fine: it bends at the grid's folds
        xs = [TOP + 0.6 + (HOLE - 1.4 - TOP - 0.6) * i / n for i in range(n + 1)]
        verts, faces = [], []
        for i, x in enumerate(xs):                                    # the groove, a strip of ice
            for z in (-0.42, 0.42):
                verts.append((x, 0.06, z))
        faces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(n)]
        poly(verts, faces, 0xbcd8f5)
        for sd in (-1, 1):                                            # its lips of snow
            for (xa, xb) in zip(xs[:-1:6], xs[6::6]):
                snowy(box((xb - xa + 0.1, 0.16, 0.18), ((xa + xb) / 2, 0.06, sd * 0.52), 0xf3f7fb), 0.45)
        disc(2.1, (HOLE, 0.0, 0.0), 0xd0e8ff, segs=24, h=0.05)        # the ice round the hole
        disc(1.35, (HOLE, 0.01, 0.0), 0x4f7fd0, segs=20, h=0.05)      # open water
        for (x, z, k, yaw) in ((HOLE + 0.8, 1.7, 0.46, -0.6), (HOLE + 1.9, 0.6, 0.42, 0.3),
                               (HOLE + 1.5, -1.5, 0.44, 0.6), (HOLE - 0.6, -1.9, 0.34, 1.2),
                               (HOLE + 2.3, -0.5, 0.4, 0.0)):
            stood_penguin(x, z, k, yaw)                              # watching at the water's edge
        for (x, z, k, yaw) in ((TOP - 0.4, -1.3, 0.44, 0.0), (TOP + 0.3, -1.9, 0.42, 0.4)):
            stood_penguin(x, z, k, yaw)                              # and from the top
        slider_penguin(HOLE + 2.6, 0.05, 1.6, 0.4)                     # one resting on its belly
        for i in range(30):                                          # the colony on the hill's face,
            r, a = math.sqrt((i + 0.5) / 30), i * 2.39996            # row over row beside the slide
            x, z = -6.5 + 5.2 * r * math.cos(a), -4.7 + 2.5 * r * math.sin(a)
            h = math.sin(i * 12.9898) * 0.5 + 0.5
            if i % 9 == 4:
                slider_penguin(x, 0.0, z, 0.4)
            else:
                stood_penguin(x, z, 0.34 if i % 7 == 3 else 0.42 + 0.06 * h, (h - 0.5) * 1.4)
    draped('chute', static)
    # the sliders' loop: up out of the snow behind the crest, over it and down
    # the groove, across the flat and into the water, home under the ice and
    # the hill
    slide = [(TOP - 4.0, -1.2, 0.0), (TOP - 1.8, 0.05, 0.0)]
    x = TOP - 0.6
    while x < HOLE - 1.0:
        slide.append((x, 0.07, 0.0))
        x += 1.0
    slide += [(HOLE - 0.5, 0.0, 0.0), (HOLE + 0.2, -0.9, 0.0)]
    slide += [(HOLE - 1.0 - 2.0 * i, -1.6, -0.6) for i in range(int((HOLE - TOP + 2.0) / 2.0))]
    for k, pt in enumerate(slide):
        marker('path_drapeslide_%d' % k, pt)
    for n in range(4):                            # spread round the loop; the renderer moves them
        x = TOP + 2.0 + 4.0 * n
        with animated('anim_path:c=drapeslide:p=13:o=%.3f#%d' % (n / 4, n), (x, 0.07, 0.0)), plain_parts():
            slider_penguin(x, 0.07, 0.0, 0.5)
    # the climbers' loop: out of the water, up the flank in a line, over the
    # top and down behind it, home under the hill; uphill no faster than the
    # colony's walkers go on the flat
    climb = [(HOLE + 0.3, -0.7, 1.0), (HOLE - 0.4, 0.02, 1.5), (0.0, 0.0, 3.2), (-4.5, 0.0, 5.2),
             (-9.0, 0.0, 5.8), (-13.5, 0.0, 4.6), (-17.0, 0.0, 2.6), (TOP - 0.6, 0.0, 1.2),
             (TOP - 2.6, 0.0, 0.9), (TOP - 4.2, -1.3, 0.9)]
    climb += [(TOP - 2.0 + 4.0 * i, -1.7, 2.6) for i in range(1, int((HOLE - TOP + 2.0) / 4.0))]
    for k, pt in enumerate(climb):
        marker('path_drapeclimb_%d' % k, pt)
    for n in range(3):
        at = climb[2 + n]
        with animated('anim_path:c=drapeclimb:p=90:o=%.3f:f=1+waddle:d=12:p=0.46#%d' % (n / 3, n), at), plain_parts():
            stood_penguin(at[0], at[2], 0.47, 0.0)

def ridge_tent(x, z, color, k=0.27, yaw=0.0):
    """A ridge tent at (x, z), its door to +X turned by `yaw`; `k` sizes it
    (0.27: a two-person tent, under a unit long)."""
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s2, dy, z - dx * s2 + dz * c)
    for sd in (-1, 1):
        box((3.2 * k, 0.06, 1.9 * k), at(0, 0.72 * k, sd * 0.66 * k), color, yaw=yaw, pitch=-sd * 0.86)
    box((3.4 * k, 0.06, 0.06), at(0, 1.46 * k, 0), 0x2a2735, yaw=yaw)
    for e in (-1, 1):                                               # the gable ends
        poly([at(e * 1.52 * k, 0.02, 1.28 * k), at(e * 1.52 * k, 0.02, -1.28 * k),
              at(e * 1.52 * k, 1.42 * k, 0)], [(0, 1, 2)], color)
    poly([at(1.56 * k, 0.02, 0.5 * k), at(1.56 * k, 0.02, -0.5 * k), at(1.56 * k, 0.95 * k, 0)],
         [(0, 1, 2)], 0x2a2735)                                     # the door

def radio_mast(MX, MZ, MH, bands, flag):
    """The expedition's radio mast at (MX, MZ), `MH` tall in `bands` red and
    white bands, its aerials, three guys pegged out round it and the flag
    flying across (+Z) from its head, moved by `flag`."""
    for i in range(bands):
        box((0.1, MH / bands, 0.1), (MX, MH / bands * (i + 0.5), MZ), 0xff5040 if i % 2 == 0 else 0xfff6eb)
    box((0.7, 0.05, 0.05), (MX, MH - 0.1, MZ), 0x555b66)              # its aerials
    box((0.05, 0.05, 0.5), (MX, MH - 0.3, MZ), 0x555b66)
    for a in (0.6, 2.7, 4.8):
        gx, gz = MX + 1.5 * math.cos(a), MZ + 1.5 * math.sin(a)
        strut((MX, MH * 0.7, MZ), (gx, 0.02, gz), 0.025, 0xc8cfdf)
    flag_across((MX, MH, MZ), 0.45, 0xff5040, flag, w=0.62, fh=0.38, pole=0x555b66)

def prayer_flags(top, ends):
    """Lines of prayer flags pulled taut from `top` down to a peg at each of
    `ends` (x, z)."""
    COLS = (0x3f7bd9, 0xfff6eb, 0xff5040, 0x61cb8b, 0xffc044)
    for end in ends:
        foot = (end[0], 0.35, end[1])
        box((0.05, 0.35, 0.05), (end[0], 0.17, end[1]), 0x9a7b55)
        strut(top, foot, 0.02, 0xc8cfdf)                            # pulled taut: one bar
        yaw = math.atan2(foot[0] - top[0], foot[2] - top[2])
        for i in range(6):
            t = (i + 0.7) / 6.6
            mx, my, mz = (top[0] + (foot[0] - top[0]) * t, top[1] + (foot[1] - top[1]) * t,
                          top[2] + (foot[2] - top[2]) * t)
            box((0.17, 0.14, 0.02), (mx, my - 0.09, mz), COLS[i % 5], yaw=yaw + math.pi / 2)

@piece(1.0)
def expedition_camp():
    # Glacier: a climbers' base camp at its real size beside a car: a cluster
    # of bright ridge tents (under a unit long) and the big blue mess tent
    # behind a curved wall of snow blocks against the wind, the radio mast
    # over them (some twelve metres, banded red and white, guyed: what reads
    # over the kerb of the raised road) flying the expedition's flag across
    # to the road, lines of prayer flags strung from its head, a long sled
    # loaded with kit, rucksacks, two climbers. All of it on the crest of its
    # snow bank (SET_GROUND), up where a racer sees it over the kerb, and
    # draped: built on y = 0 and laid on the bank as the renderer draws it.
    ridge_tent(0.0, 0.0, 0xff7e44)
    ridge_tent(-0.3, 0.9, 0xcf534f)
    ridge_tent(0.2, -0.95, 0xffc044)
    ridge_tent(0.9, 1.9, 0x61cb8b, yaw=-0.4)
    ridge_tent(1.0, -2.0, 0xff5040, yaw=0.5)
    ridge_tent(-1.4, -0.4, 0x3f7bd9, k=0.42, yaw=0.15)              # the mess tent
    for k in range(7):                                              # the wind wall, round the back
        a = -1.25 + k * 0.42
        snowy(box((0.18, 0.3, 0.55), (-2.05 - 0.6 * math.cos(a) + 0.6, 0.15, 1.6 * math.sin(a)), 0xf3f7fb,
                  yaw=a), 0.4)
    sled(1.4, 0, 0.9, 0.3, 0x9a7b55, L=0.7)
    box((0.22, 0.12, 0.3), (1.42, 0.2, 0.9), 0x3f7bd9, yaw=0.3)     # its load
    for (x, z, c) in ((1.25, -0.35, 0xcf534f), (1.35, -0.15, 0x61cb8b)):
        box((0.12, 0.18, 0.1), (x, 0.09, z), c, yaw=0.3)
    snow_person(1.6, 0, -0.6, 0xcf534f, 0x38383d, yaw=0.5)
    snow_person(1.75, 0, 0.25, 0x3f7bd9, 0xffc044, yaw=-0.6)
    # the radio mast, banded, its guys pegged out round it; prayer flags: two
    # lines from the mast's head down to pegs toward the road
    MX, MZ, MH = -0.5, -2.2, 2.8
    radio_mast(MX, MZ, MH, 7, 'anim_drape+sway:a=x:d=24:p=1.9#1')
    prayer_flags((MX, MH - 0.35, MZ), ((1.9, -3.4), (2.1, -0.9)))
    # draped, the flag too (`drape`): the bank's crest is drawn on the 9 u
    # grid, half a unit and more off its flat top
    group([o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('anim') is None],
          'drape_camp')

@piece(1.0)
def advanced_camp():
    # Glacier: the expedition's advanced camp, a lap on from its base camp
    # and smaller, as a camp up the mountain is: four ridge tents in a row
    # and the store tent behind them, a short wall of snow blocks at the back,
    # no mess tent and no sled, the radio mast (what reads over the kerb)
    # flying the expedition's flag with one line of prayer flags, two ice axes
    # stood in the snow, two climbers by the tents. Close set, on a low bank
    # (SET_GROUND), so the slope it stands near tips no tent: draped, built on
    # y = 0 and laid on the snow as the renderer draws it.
    for (z, c) in ((-1.3, 0xff7e44), (-0.43, 0xffc044), (0.43, 0xcf534f), (1.3, 0x3f7bd9)):
        ridge_tent(0.2, z, c)
    ridge_tent(-1.3, 0.0, 0x61cb8b, k=0.38, yaw=math.pi / 2)        # the store tent, behind
    for k in range(5):                                              # the wind wall behind them
        snowy(box((0.18, 0.3, 0.55), (-2.1, 0.15, -1.4 + k * 0.7), 0xf3f7fb, yaw=0.1 * (k - 2)), 0.4)
    for (x, z) in ((1.0, -0.2), (1.05, 0.05)):                      # ice axes stood in the snow
        box((0.04, 0.32, 0.04), (x, 0.16, z), 0x555b66)
        box((0.16, 0.04, 0.04), (x, 0.32, z), 0x2a2735)
    snow_person(1.2, 0, -0.9, 0x3f7bd9, 0xcf534f, yaw=0.4)
    snow_person(1.3, 0, 0.8, 0x61cb8b, 0x38383d, yaw=-0.5)
    MX, MZ, MH = -0.3, 2.3, 2.8
    radio_mast(MX, MZ, MH, 7, 'anim_drape+sway:a=x:d=24:p=1.7#1')
    prayer_flags((MX, MH - 0.35, MZ), ((1.6, 3.2),))
    group([o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('anim') is None],
          'drape_camp')

def snow_rake(x, z0, z1):
    """A row of snow rakes across a slope at `x`, from z0 to z1, built on the
    plain for a drape: posts a unit tall leaning into the hill (-X), the
    slatted boards between them."""
    n = max(2, int(round((z1 - z0) / 2.0)))
    zs = [z0 + (z1 - z0) * i / n for i in range(n + 1)]
    for z in zs:                                                    # posts, leaning into the hill
        box((0.1, 1.3, 0.1), (x, 0.35, z), 0x6e4a32, roll=0.35)
    for za, zb in zip(zs[:-1], zs[1:]):                             # the slatted boards between them
        box((0.06, 0.7, zb - za), (x - 0.08, 0.55, (za + zb) / 2), 0x8a6a46, roll=0.35)

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
    def defences():
        for (x, half) in ((-6.0, 6.0), (-10.5, 7.5), (-15.0, 8.5), (-19.5, 8.0)):
            snow_rake(x, -half, half)
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
    # foot and up the face, a pine. Above it the slope's defences, three rows
    # of snow rakes stepping up the face: the sign alone is a speck from the
    # road, the rakes are lines across the white a racer reads as the
    # avalanche fences' slope.
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
        for (x, half) in ((-9.5, 5.0), (-14.0, 6.0), (-18.5, 6.5)):
            snow_rake(x, -half, half)
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

def person(at, yaw, shirt, k=1.0, hair=0, legs=0x4f5260, sit=False, arm=0.0, kick=0.0, gesture=None):
    """Someone facing +X turned by `yaw`, 1.9 tall at k 1 (a child is about
    0.7): blocks, the cars' way, about twice life size across so they read.
    Sitting, the seat is at `at` and the legs reach forward off it. `arm`
    lifts the arms forward (radians), to hold a rope or a ribbon. `kick`
    stands them on the left leg with the right swung forward that far
    (radians), a ball just struck. `gesture` names the arms' motion
    (a one-way `anim_sway...:r=` with a rest), turning about the shoulders: the one movement a
    person here makes of their own (set_motion.h)."""
    L = local(at[0], at[2], yaw)
    y = at[1]
    if sit:
        box((0.6 * k, 0.24 * k, 0.44 * k), L(0.2 * k, y + 0.12 * k, 0), legs, yaw=yaw)
        box((0.22 * k, 0.5 * k, 0.44 * k), L(0.42 * k, y - 0.12 * k, 0), legs, yaw=yaw)
        b = y + 0.22 * k
    elif kick:
        box((0.32 * k, 0.86 * k, 0.21 * k), L(0, y + 0.43 * k, 0.11 * k), legs, yaw=yaw)
        box((0.3 * k, 0.86 * k, 0.2 * k), L(0.43 * k * math.sin(kick), y + 0.86 * k - 0.43 * k * math.cos(kick), -0.11 * k),
            legs, yaw=yaw, roll=-kick)
        b = y + 0.84 * k
    else:
        box((0.32 * k, 0.86 * k, 0.44 * k), L(0, y + 0.43 * k, 0), legs, yaw=yaw)
        b = y + 0.84 * k
    box((0.4 * k, 0.64 * k, 0.54 * k), L(0, b + 0.32 * k, 0), shirt, yaw=yaw)
    def arms():
        for s in (-1, 1):
            box((0.2 * k, 0.56 * k, 0.17 * k), L(0.05 * k + 0.28 * k * math.sin(arm), b + 0.58 * k - 0.28 * k * math.cos(arm), s * 0.35 * k),
                shirt, yaw=yaw, roll=-arm)
    if gesture:
        with animated(gesture, L(0.05 * k, b + 0.58 * k, 0), yaw=yaw):
            arms()
    else:
        arms()
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
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p, t) for n, (x, y, z), yaw, p, t in ANIMS]
    join_still('cottages')

@piece(REAL)
def village_church():
    # The church: nave along Z under a slate roof, the tower at its -Z end
    # carrying the spire (the tallest thing in the village, about six cars),
    # a porch on the road side (+X), the clock; yews and headstones in the
    # churchyard behind. On the green before it the maypole stands, its
    # ribbons loose in the breeze, the children round it between dances.
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
    # The dance has stopped for a breather: the children stand round the
    # pole and its ribbons hang loose off the crown, each lifting and
    # falling in the breeze on its own. The wind moves, nobody does: a ring
    # of children carried round the pole read as figures gliding over the
    # grass, skipping or not.
    cyl(0.75, 0.5, (MX, 8.2, 0), 0xffc044, segs=8)
    for k in range(6):
        a = k * 2 * math.pi / 6 + 0.5
        ax, az = MX + 0.6 * math.cos(a), 0.6 * math.sin(a)
        with animated('anim_sway:a=z:d=14:p=%.2f#rib%d' % (2.4 + 0.25 * k, k), (ax, 8.3, az), yaw=-a):
            strut((ax, 8.3, az), (MX + 2.2 * math.cos(a), 2.6, 2.2 * math.sin(a)), 0.12, COLS[(k + 3) % 8])
    for k in range(6):
        a = k * 2 * math.pi / 6
        person((MX + 4.4 * math.cos(a), 0, 4.4 * math.sin(a)), math.pi - a, COLS[k], k=0.7, hair=k, arm=0.25 * (k % 2))
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
    with animated('anim_bob:h=0.16:p=0.8:b=1', (TX, ty + 0.92, TZ)):    # about her own height, landing on the mat
        person((TX, ty + 0.92, TZ), 0.6, 0xff5040, k=0.7, hair=2, arm=2.6)
    kennel((-4.5, G(-4.5, 6.0), 6.0), 1.2)
    for o in bpy.context.scene.objects:          # onto the summit
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p, t) for n, (x, y, z), yaw, p, t in ANIMS]
    join_still('oak')

@piece(REAL)
def swing_oak():
    # Pretzel: another of the garden's old oaks out by a bend, the tall thing
    # a racer on a deck riding over the lawn sees: a tyre swing from its low
    # bough with a child riding it, a bike dropped at the trunk. The same tree
    # as the treehouse's, a little smaller, so the summer reaches round the
    # lap without a second den.
    BARK = 0x7a5a3a
    cyl(1.2, 12.0, (0, -0.5, 0), BARK, r2=0.8, segs=9)
    for a, r, h in ((2.2, 0.5, 4.4), (4.4, 0.45, 4.0)):
        o = cyl(r, h, (0, 7.5, 0), BARK, r2=0.22, segs=7, smooth=False)
        tilted(o, math.cos(a) * 0.9, math.sin(a) * 0.9)
    for c, r in (((0, 14.5, 0), 5.2), ((-4.0, 13.0, 2.6), 3.9), ((3.6, 13.4, -2.8), 3.8),
                 ((0.8, 17.6, 2.0), 3.6), ((-1.8, 16.4, -3.0), 3.2)):
        sphere(r, c, 0x5f9f4a if r > 4.0 else 0x6cae55, subdiv=1)
    # the swing's bough out toward the road (+X), the tyre on its rope
    BX, BZ = 5.0, 1.0
    strut((0.0, 8.0, 0.2), (BX, 8.9, BZ), 0.6, BARK)
    with animated('anim_sway:a=x:d=24:p=2.6', (BX - 0.3, 8.6, BZ)):
        strut((BX - 0.3, 8.7, BZ), (BX - 0.3, 1.3, BZ), 0.08, 0x9a7b55)
        torus(0.55, 0.2, (BX - 0.3, 0.95, BZ), 0x2a2735, segs=12, axis='across')
        person((BX - 0.3, 0.85, BZ), 0.0, 0x22c46e, k=0.65, hair=2, sit=True)
    # the bike dropped on the grass at the trunk
    for z in (-0.9, 0.9):
        torus(0.55, 0.1, (2.2, 0.12, -2.0 + z), 0x2a2735, segs=10)
    box((0.12, 0.12, 1.8), (2.2, 0.2, -2.0), 0xff5040)
    join_still('oak')

@piece(REAL)
def football_pitch():
    # Pretzel: the village pitch laid along the road, its lines painted on
    # the lawn, little goals at the ends, and a kickabout on. Nobody runs: a
    # body sliding over the grass reads uncanny however it is posed. Three
    # children stand in a triangle in the far half, each just having
    # struck the ball on to the next, and the BALL is what moves, lofted from
    # foot to foot round the triangle. The keepers wait on their lines, arms
    # going up now and then, a child on the touchline cheering (gestures).
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
    # the keepers on their lines, arms out ready, going up now and then
    for s, c, hair, p in ((-1, 0x22c46e, 1, 4.6), (1, 0xa259e6, 3, 5.3)):
        person((0, 0, s * (PL / 2 - 1.0)), s * math.pi / 2, c, k=0.72, hair=hair, arm=0.9,
               gesture='anim_sway:a=z:d=110:p=%.1f:r=0.65#keep%d' % (p, s + 1))
    # the passing triangle: each child faces the next, the right foot through
    TRI = [(6.0, -10.0, 0xff5040), (7.0, 2.0, 0x339cf2), (-2.0, -4.0, 0xff5040)]
    feet = []
    for i, (x, z, c) in enumerate(TRI):
        nx, nz, _ = TRI[(i + 1) % 3]
        d = math.hypot(nx - x, nz - z)
        ux, uz = (nx - x) / d, (nz - z) / d
        person((x, 0, z), math.atan2(-uz, ux), c, k=0.72, hair=i, arm=0.5, kick=0.8)
        feet.append((x + 0.55 * ux, z + 0.55 * uz))
    # two more standing off, watching the ball
    for i, (x, z, c) in enumerate(((-6.0, 7.0, 0x339cf2), (2.5, 11.0, 0xff5040))):
        person((x, 0, z), math.atan2(-(-4.0 - z), 3.0 - x), c, k=0.72, hair=i + 2)
    # the ball's round: lofted from each foot, landing a stride short of the
    # next and rolling in to it (a closed path, the ball steady along it).
    # A real ball's size at the toy world's chunkiness (about 1.5x): a ball
    # half a child's height read as a beach ball, and a block that small
    # reads as a box, so it is a smooth one.
    R, LOFT, ROLL = 0.18, 1.6, 1.2
    pts = []
    for i in range(3):
        (x0, z0), (x1, z1) = feet[i], feet[(i + 1) % 3]
        d = math.hypot(x1 - x0, z1 - z0)
        lx, lz = x1 - (x1 - x0) * ROLL / d, z1 - (z1 - z0) * ROLL / d
        for j in range(8):
            u = j / 8
            pts.append((x0 + (lx - x0) * u, R + 4 * LOFT * u * (1 - u), z0 + (lz - z0) * u))
        pts.append((lx, R, lz))
    for k, at in enumerate(pts):
        marker('path_ball_%d' % k, at)
    with animated('anim_path:c=ball:p=6:f=0', pts[0]):
        sphere(R, pts[0], 'white', flat=False)
    # a child on the touchline cheering them on
    person((-PW / 2 - 1.6, 0, 9.0), 0.0, 0xffc044, k=0.68, hair=2, arm=0.2,
           gesture='anim_sway:a=z:d=150:p=3.8:r=0.7#cheer')
    # mums and dads on a bench on the far touchline (+X; the road runs along
    # the -X one)
    PZ = 12.0
    bench((PW / 2 + 2.5, 0, PZ - 3.0), yaw=-math.pi / 2)
    bench((PW / 2 + 2.5, 0, PZ + 3.0), yaw=-math.pi / 2)
    person((PW / 2 + 2.6, 0.5, PZ - 3.0), math.pi, 0xa259e6, hair=1, sit=True)
    person((PW / 2 + 2.6, 0.5, PZ + 3.3), math.pi, 0xffc044, hair=3, sit=True)
    # the club's pavilion they sit in front of, under its veranda, facing the
    # pitch across it from the road: white boards under a red roof, the club
    # flag over the ridge. A real one's size (two cars long); it is what
    # stands up off the lawn, so it is what says pitch from a car whose kerb
    # hides the lines, and from the far side it stands behind the game, not
    # in front of it.
    D, L, H = 4.4, 10.0, 3.4
    PF = local(PW / 2 + 3.2 + D / 2, PZ, math.pi)
    box((D, H, L), PF(0, H / 2, 0), 'white', yaw=0.0)
    ridge = gable_roof(PF, 0.0, 0.0, D, L, H, 0xcf534f, 'white')
    box((1.8, 0.2, L), PF(D / 2 + 0.9, H - 0.4, 0), 0x9a7b55, yaw=0.0)     # the veranda roof
    for z in (-L / 2 + 0.3, 0.0, L / 2 - 0.3):
        box((0.2, H - 0.4, 0.2), PF(D / 2 + 1.7, (H - 0.4) / 2, z), 0x9a7b55, yaw=0.0)
    box((0.14, 2.1, 1.2), PF(D / 2 + 0.06, 1.05, 0), 0x339cf2, yaw=0.0)
    for z in (-3.0, 3.0):
        window(PF, 0.0, D / 2, 2.0, z, w=1.4, h=1.0)
    flagpole(PF(0, ridge - 0.3, 0), 4.2, 0x339cf2, w=1.6, fh=0.9, pole='white',
             wave='anim_sway:a=z:d=22:p=1.6#club')
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
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p, t) for n, (x, y, z), yaw, p, t in ANIMS]
    join_still('camp')

# ---- TANGLE: the mill stream ------------------------------------------------------------
# Tangle's stream rises in the north loop, runs under the S-bend's bridge
# and the first bridge and over the north lawn to the mill pond on the west,
# ahead of the grid, where the watermill's wheel turns in the race. The
# stream is laid reach by reach (set-stream-reach, each placed along its
# stretch, their tapered ends overlapping); the mill is the hero. Water is a
# flat sheet on the lawn: from a deck riding over the garden it is a line of
# blue under the kerb, so each reach brings a willow on its bank, the tall
# thing that says stream.
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
    # a willow on the -X bank a quarter of the way along, hanging over the
    # water: the tall thing that says stream from a deck riding over the
    # lawn, where the water itself is a line under the kerb. Turning a reach
    # half round puts it on the other bank at the other end.
    willow((-W - 3.4, 0, -REACH / 4))
    join_still('drape_reach')

def willow(at):
    """A weeping willow by the water, about as tall as a garden oak (three
    cars): a short trunk, a round crown and the curtain of its hanging
    branches down to a car's height off the ground."""
    x, y, z = at
    cyl(0.8, 8.0, (x, y, z), 0x7a5a3a, r2=0.5, segs=7)
    sphere(4.6, (x, y + 9.6, z), 0x6cae55, subdiv=1, scale=(1.0, 0.7, 1.0))
    cyl(5.0, 6.0, (x, y + 3.4, z), 0x61cb8b, r2=4.2, segs=10)

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
        with animated('anim_path:c=duck:p=44:o=%.3f:f=1+bob:h=0.015:p=1.6#%d' % (j / 3 + 0.04 * j, j), (PX + 8.0, 0.3, PZ)):
            duck((PX + 8.0, 0.3, PZ), (0xf8f8fb, 0x9a7b55, 0xf8f8fb)[j])
    willow((PX - 10.0, 0, PZ - 8.0))
    AX, AZ = PX - PR - 2.2, PZ + 4.0
    bench((AX, 0, AZ), yaw=math.pi / 2)
    person((AX - 0.1, 0.5, AZ), 0.0, 0x22c46e, hair=1, sit=True, arm=0.6)
    with animated('anim_sway:a=z:d=9:p=4.5:r=0.75#rod', (AX + 0.3, 0.9, AZ + 0.35)):   # the rod jigs
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

def slide_tower(TX, TZ, DY=1.6):
    """A climbing tower: a deck on four posts under a red roof, a slide off
    its +X side, a ladder up its back."""
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

def climbing_net(NX, NZ, NH=7.0, NR=2.6):
    """The climbing net: a rope pyramid on a mast, the tallest thing in a
    park as it is in a real one (about seven metres)."""
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
    # the climbing tower, its slide off the road side (+X)
    TX, TZ, DY = 1.5, 5.0, 1.6
    slide_tower(TX, TZ)
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
    # the climbing net, two children up it
    NX, NZ, NH = -2.0, 8.6, 7.0
    climbing_net(NX, NZ)
    person((NX + 1.3, NH * 0.33 + 0.05, NZ - 1.4), 2.3, 0x22c46e, k=0.62, hair=1, arm=2.4)
    person((NX - 0.6, NH * 0.66 + 0.05, NZ + 0.5), 0.9, 0xffc044, k=0.6, hair=2, arm=2.6)
    # the benches round it, two of the grown-ups watching
    for z, c in ((-3.0, 0xa259e6), (6.5, 0xffc044)):
        bench((-8.4, 0, z), yaw=math.pi / 2)
        person((-8.5, 0.5, z + 0.2), 0.0, c, hair=1 if z < 0 else 3, sit=True)
    # the ice-cream van up on the hill at the end of the swings, its hatch to
    # the road and the children queueing at it: part of the scene a racer
    # reads as one shape, where on its own at the hill's foot it was a car's
    # size under the kerb (and no nearer the road, where the land a deck
    # holds down falls away under it)
    ice_cream_van(4.0, -15.0)
    for o in bpy.context.scene.objects:          # onto the summit
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p, t) for n, (x, y, z), yaw, p, t in ANIMS]
    join_still('playground')

@piece(REAL)
def play_corner():
    # Another corner of the same park on a low knoll of its own (SET_GROUND),
    # so the playground's afternoon reaches round the lap: the climbing net
    # standing over a slide tower, its slide toward the road (+X), a pair of
    # swings going, a grown-up on the bench. Built from the summit and lifted
    # onto it.
    s0 = set_ground('play-corner')(0.0, 0.0)
    box((12.0, 0.6, 13.0), (0, -0.18, 0), 0xb08a5a)
    climbing_net(-2.5, 2.5)
    slide_tower(1.0, -3.0)
    person((1.3, 1.7, -3.3), 0.3, 0xff5040, k=0.68, hair=1)
    person((-1.2, 7.0 * 0.5 + 0.05, 2.9), 0.9, 0x339cf2, k=0.62, hair=2, arm=2.6)
    SX, top = -4.0, 2.6
    for z in (-6.0, -1.6):
        for k in (-1, 1):
            strut((SX + k * 1.3, 0, z), (SX, top, z), 0.2, 0x22c46e)
    box((0.24, 0.24, 4.8), (SX, top, -3.8), 0x22c46e)
    kid_swing(2, SX, -4.9, top, 0xa259e6, 3)
    kid_swing(3, SX, -2.7, top, 0xffc044, 0)
    bench((-5.2, 0, 4.5), yaw=math.pi / 2)
    person((-5.3, 0.5, 4.7), 0.0, 0x22c46e, hair=2, sit=True)
    for o in bpy.context.scene.objects:          # onto the summit
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p, t) for n, (x, y, z), yaw, p, t in ANIMS]
    join_still('corner')

def ice_cream_van(ox, oz):
    """The park's ice-cream van parked at (ox, oz) of the piece's frame: a van
    along a gravel lay-by (its length Z, the serving hatch on +X) under the
    big cone on its roof turning, the children queueing at the hatch, one
    waving, a grown-up on the bench with a cone. Real size: about one and a
    half cars long. Built at the origin, then moved there."""
    before, n = set(bpy.context.scene.objects), len(ANIMS)
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
    # the queue at the hatch, facing it, the second child's arms going up
    person((2.3, 0, -1.6), math.pi, 0xff5040, k=0.68, hair=1, arm=0.6)
    person((3.0, 0, -0.4), math.pi * 0.9, 0x22c46e, k=0.64, hair=2, arm=0.3,
           gesture='anim_sway:a=z:d=140:p=3.2:r=0.65#kid')
    person((3.4, 0, 0.8), math.pi * 0.85, 0xa259e6, k=0.7, hair=3)
    person((3.7, 0, 1.9), math.pi * 0.85, 0x339cf2, hair=0)
    # the bench along the back of the lay-by, a grown-up with a cone
    bench((3.4, 0, -3.6), yaw=-math.pi / 2)
    person((3.5, 0.5, -3.6), math.pi, 0xffc044, hair=3, sit=True, arm=1.0)
    for o in bpy.context.scene.objects:
        if o not in before:
            o.location.x += ox
            o.location.y -= oz
    ANIMS[n:] = [(nm, (x + ox, y, z + oz), yaw, p, t) for nm, (x, y, z), yaw, p, t in ANIMS[n:]]

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

def hawk_circle(c, y, R, period, k=1.0, tag='hawk'):
    """A hawk circling over the piece: a closed loop of `path_<tag>_<n>`
    empties `R` round (cx, cz) at height `y`, and the bird riding it
    (anim_path facing its way), wings spread and banked into the turn, 0.55
    u from tip to tip: twice a real hawk's span, the scale rule's most for a
    small living thing, flying low enough to read against the sky. `k` is the world's size in the builder's units (1 / the piece's
    grow). The bird is BUILT on the ground under the circle, its low wing
    tip on the floor: a traveller is drawn only on its path, so where it is
    built is just its pivot, and a bird built up in the air would stand in
    the piece's box, its sight points and the floating check as a part 5 u
    up that nothing holds."""
    cx, cz = c
    k *= 0.44                                            # the parts below are a 1.26 span's
    N = 24
    for n in range(N):                                   # angle up: +Z first, the centre on its right
        a = 2 * math.pi * n / N
        marker('path_%s_%d' % (tag, n), (cx + R * math.cos(a), y, cz + R * math.sin(a)))
    x0, y0, z0 = cx + R, 0.16 * k, cz
    bank = -0.38                                         # right wing (+Z) down, into the turn
    cb, sb = math.cos(bank), math.sin(bank)
    def b(size, dx, dy, dz, color):                      # a part of the bird, its frame tipped by the bank
        box([s * k for s in size], (x0 + dx * k, y0 + (dy * cb + dz * sb) * k, z0 + (-dy * sb + dz * cb) * k),
            color, pitch=bank)
    with animated('anim_path:c=%s:p=%.1f:f=1#%s' % (tag, period, tag), (x0, y0, z0)):
        b((0.34, 0.09, 0.11), 0, 0, 0, 'dark')                                   # the body
        b((0.09, 0.08, 0.09), 0.2, 0.03, 0, 'dark')                              # the head
        b((0.06, 0.04, 0.05), 0.26, 0.02, 0, 'yellow')                           # the bill
        b((0.14, 0.03, 0.16), -0.22, 0.0, 0, 'salmon')                           # the red tail, fanned
        for sd in (-1, 1):                                                       # the wings, a little raised
            b((0.2, 0.03, 0.42), 0.02, 0.03, sd * 0.26, 'dark')
            b((0.12, 0.03, 0.2), -0.02, 0.06, sd * 0.53, 'slate')               # the fingered tips

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
    # between dark banks, stones on the bars, a saguaro and an ocotillo on
    # the bank. Tumbleweeds, each half a car high, blow down it: each rolls out of the
    # rock pile at the upwind end, bowls the length of the bed at a gust's
    # pace, bouncing and landing (a bob with a rest) and rolling as fast as it
    # goes, and vanishes into the pile at the far end; the hidden half of the
    # loop runs back under the ground (anim_path+spin+bob). A hawk circles
    # over the bed.
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
    with plain_parts():                                                # in builder units: 1/1.45 of the world's
        saguaro((-6.0, 0, zc(-6.0) + 4.4), 2.5, arms=((0.4, 0.45, 0.3), (3.4, 0.58, 0.24)))
        ocotillo((-7.3, 0, zc(-7.3) + 3.6), 1.4, seed=3)
        brush((-5.0, 0, zc(-5.0) + 5.2), 0.7)
    sandstone_rock((-4.4, 0, zc(-4.4) + 3.2), 0.8, yaw=0.4)
    sandstone_rock((10.0, 0, zc(10.0) + 3.0), 0.7, yaw=1.2)
    # the tumbleweeds' loop: down the bed at its own height, then back under it
    R = 0.17
    xs = [-END + 2 * END * i / 12 for i in range(13)]
    for k, pt in enumerate([(x, R, zc(x)) for x in xs] + [(END, -1.9, zc(END)), (-END, -1.9, zc(-END))]):
        marker('path_weed_%d' % k, pt)
    for n in range(4):
        x = xs[1 + 3 * n]
        with animated('anim_path:c=weed:p=56:o=%.3f:f=1+spin:a=z:w=-11+bob:h=0.2:p=%.2f:r=0.35#%d'
                      % (n / 4, 0.7 + 0.06 * n, n), (x, R, zc(x))):
            tumbleweed((x, R, zc(x)), R)
    hawk_circle((2.0, 1.5), 3.6, 3.0, 15.0, k=1 / 1.45)

def saguaro(at, h, arms=((0.0, 0.45, 0.55),), yaw=0.0):
    """A saguaro `h` tall, the desert's own tall plant: a fat ribbed column
    (five faceted sides, tapering to its crown), each of its `arms` (turn
    about the trunk, height up it as a share of h, length up as a share of
    h) an elbow out from the trunk and a column up from it, tapering to its
    tip. Faceted round in section, as a cactus is, the arms only four-sided:
    a two-armed one is some 130 vertices. The elbow is a square bar, flat on
    top and square to the arm it carries, as the kit's own cactus is: a
    four-sided one stood on its edge shows a lit lozenge from above, and a
    row of those up a trunk reads as a fir's tiers."""
    x, y, z = at
    r = 0.085 * h
    cyl(r, h, (x, y, z), 'green', r2=r * 0.6, segs=5, stem=True)
    ra = r * 0.9
    side = ra * math.sqrt(2)                                     # the arm's square, corner radius ra
    for a, at_h, up in arms:
        a += yaw
        c, sn = math.cos(a), math.sin(a)
        reach = r + ra * 2.0                                     # the arm's axis, out from the trunk's
        L = reach + side / 2                                     # the elbow, trunk axis to the arm's far face
        ey = y + h * at_h
        box((L, side, side), (x + c * L / 2, ey, z - sn * L / 2), 'green', yaw=a)
        ax, az = x + c * reach, z - sn * reach
        cyl(ra, h * up, (ax, ey - side / 2, az), 'green', r2=ra * 0.62, segs=4, yaw=a + math.pi / 4, stem=True)

def ocotillo(at, h, n=5, seed=0):
    """An ocotillo `h` tall: a fountain of long spiny canes splaying from one
    root, each tipped with its red flower spike."""
    x, y, z = at
    for i in range(n):
        a = 2 * math.pi * (i + 0.37 * seed) / n
        lean = 0.22 + 0.12 * ((i * 5 + seed) % 3)
        L = h * (0.82 + 0.06 * ((i * 3 + seed) % 4))
        tip = (x + math.cos(a) * math.sin(lean) * L, y + math.cos(lean) * L, z - math.sin(a) * math.sin(lean) * L)
        rod((x, y, z), tip, 0.1, 'green', r2=0.07, segs=3)
        top = (tip[0] + (tip[0] - x) * 0.1, tip[1] + 0.24, tip[2] + (tip[2] - z) * 0.1)
        rod(tip, top, 0.1, 'red', r2=0.05, segs=3)

def brush(at, k=1.0, yaw=0.0):
    """A clump of desert brush (creosote, bursage): two low faceted domes."""
    x, y, z = at
    cyl(0.55 * k, 0.42 * k, (x, y, z), 'green', r2=0.25 * k, segs=5, yaw=yaw, stem=True)
    cyl(0.38 * k, 0.3 * k, (x + 0.48 * k, y, z + 0.3 * k), 'green', r2=0.16 * k, segs=5, yaw=yaw + 0.5, stem=True)

def barrel_cactus(at, k=1.0):
    """A barrel cactus a knee high, its crown in flower."""
    x, y, z = at
    cyl(0.24 * k, 0.38 * k, (x, y, z), 'green', r2=0.2 * k, segs=5, stem=True)
    cyl(0.2 * k, 0.08 * k, (x, y + 0.38 * k, z), 'red', r2=0.1 * k, segs=5, stem=True)

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
    # The bed lies in its channel under the raised land, out of a racer's
    # sight but close by; what shows where the wash runs is what grows along
    # it, where the water is underground: on each bank a stand of saguaros
    # (the old one an old one's height, some fifteen metres), brush at a
    # foot, and red boulders on the bar. No tree: a desert wash reads as cactus and rock. The bed keeps
    # the shade it had under its stones (shade() runs the ramp to the
    # piece's new top, the saguaros). Where a reach runs under the road the
    # stands keep to the footprint every placement's road passes a kerb
    # clear of.
    bed = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for o in bed:
        o['ramp'] = 0.84
    with plain_parts():
        saguaro((5.0, 0, 1.5), 4.6, arms=((0.3, 0.36, 0.42), (3.5, 0.48, 0.36), (1.9, 0.6, 0.26)))
        saguaro((5.9, 0, 0.5), 3.2, arms=((2.2, 0.45, 0.36),))
        brush((4.1, 0, 2.3), 1.2)
        saguaro((-4.0, 0, 3.5), 4.2, arms=((3.6, 0.4, 0.42), (0.4, 0.52, 0.32)))
        saguaro((-3.4, 0, 4.3), 2.9, arms=((5.0, 0.48, 0.34),))
        sandstone_rock((3.2, 0, 5.0), 1.4, yaw=0.7)
        sandstone_rock((-3.0, 0, 2.4), 1.2, yaw=2.1)
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
    # Beside the low start straight the line crosses the flat on a timber
    # trestle, up a ramp out of the yard and down one into its cutting where
    # the land rises toward the high bend: rails on the sand are a line a
    # racer cannot read at that distance, a trestle a car high with the train
    # riding along it is the mine's line seen from the road.
    T0, T1, RISE, RAMP = 5.0 / k, 36.0 / k, 1.4 / k, 7.0 / k
    def ry(s):
        """The rails' height at `s` along the line."""
        t = min(1.0, max(0.0, (s - T0) / RAMP), max(0.0, (T1 - s) / RAMP))
        return Y + RISE * t * t * (3 - 2 * t)
    BENT = 2.6 / k
    nr = max(3, math.ceil(total / RAIL))
    ss = [total * i / nr for i in range(nr + 1)]
    for a0 in (T0, T1 - RAMP):                                   # the ramps in chords of a quarter
        for q in range(5):
            x = a0 + RAMP * q / 4
            if not any(abs(x - v) < RAMP / 8 for v in ss):
                ss.append(x)
    ss.sort()
    nr = len(ss) - 1
    for run in range(3):
        before = set(bpy.context.scene.objects)
        i0, i1 = nr * run // 3, nr * (run + 1) // 3
        for i in range(i0, i1):
            (pa, da), (pb, db) = on(ss[i]), on(ss[i + 1])
            ya, yb = ry(ss[i]), ry(ss[i + 1])
            for sd in (-1, 1):
                a = (pa[0] + da[1] * 0.6 * sd, ya, pa[1] - da[0] * 0.6 * sd)
                b = (pb[0] + db[1] * 0.6 * sd, yb, pb[1] - db[0] * 0.6 * sd)
                strut(a, b, 0.2, 'slate')
                if max(ya, yb) > Y + 0.3:                            # the trestle's stringers
                    strut((a[0], a[1] - 0.35, a[2]), (b[0], b[1] - 0.35, b[2]), 0.4, TIMBER)
        s = ss[i0] + TIE / 2
        while s < ss[i1]:
            p, d = on(s)
            box((1.8, 0.2, 0.5), (p[0], ry(s) - 0.2, p[1]), TIMBER, yaw=math.atan2(d[0], d[1]))
            s += TIE
        s = T0 + BENT / 2                                            # the trestle's bents
        while s < T1:
            if ss[i0] <= s < ss[i1] and ry(s) > Y + 0.5:
                (p, d), h = on(s), ry(s) - 0.55
                yaw = math.atan2(d[0], d[1])
                foot = [(p[0] + d[1] * 1.2 * sd, 0.0, p[1] - d[0] * 1.2 * sd) for sd in (-1, 1)]
                head = [(p[0] + d[1] * 0.9 * sd, h, p[1] - d[0] * 0.9 * sd) for sd in (-1, 1)]
                for f, t in zip(foot, head):
                    strut(f, t, 0.32, TIMBER)
                box((2.6, 0.3, 0.42), (p[0], h, p[1]), TIMBER, yaw=yaw)
                strut(foot[0], head[1], 0.16, TIMBER)
            s += BENT
        group([o for o in bpy.context.scene.objects if o not in before and o.type == 'MESH'], 'line%d' % run)
    # the train's loop: up out of the ground behind the adit, out along the
    # portal's line, the length of this one (over the trestle), onto the
    # headframe's collar (the headframe stands 1.26 world on from the line's
    # end, its collar 1 of its own units toward the line) and down the
    # shaft, then home under everything
    CO = (1.26 - GROW['headframe']) / k
    loop = [(-8.0, -3.0, 0.0), (-5.2, Y, 0.0)]
    loop += [(p[0], ry(s), p[1]) for p, s in ((on(s)[0], s) for s in ss)]
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

@piece(1.0)
@plain
def saguaro_stand():
    # Wash's support: a stand of saguaros on the bank, the old one an old
    # one's height (some fifteen metres, its three arms up), a young one
    # beside it, an ocotillo in flower, brush and a barrel cactus at their
    # feet, red rocks among them; a vulture perched
    # on the old one's crown, turning to watch the road (anim_watch).
    H = 4.2
    saguaro((0, 0, 0), H, arms=((0.2, 0.4, 0.34), (2.9, 0.52, 0.28), (4.6, 0.62, 0.2)))
    saguaro((1.5, 0, -1.4), 1.8, arms=((0.6, 0.5, 0.3),))
    ocotillo((-1.6, 0, 1.4), 2.2, seed=4)
    brush((1.2, 0, 1.3), 1.0, yaw=0.4)
    barrel_cactus((-1.1, 0, -1.6), 1.1)
    vy, k = H, 0.47                                                              # the vulture, turning
    def v(size, d, color, pitch=0.0):                                            # on its perch to watch
        box([s * k for s in size], (d[0] * k, vy + d[1] * k, d[2] * k), color, pitch=pitch)   # the cars go by
    with animated('anim_watch:r=24:d=75#v', (0, vy, 0)):
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
    sandstone_rock((-1.4, 0, -0.6), 0.9, yaw=1.2)
    sandstone_rock((1.6, 0, -2.9), 0.7, yaw=0.2)
    join_still('stand')

def windpump_body(x0, z0, k, tag='', yaw=0.0):
    """An old farm windpump at (x0, z0), `k` the size of the 7 unit one: a
    wooden tower braced corner to corner, the wheel of narrow wooden blades
    up top facing +X turned by `yaw` (into the wind) with its tail vane
    behind, the pump rod down the middle to the pump head, its spout over a
    plank trough at the foot. The wheel turns (anim_spin)."""
    before = set(bpy.context.scene.objects)
    c, s = math.cos(yaw), math.sin(yaw)
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
    with animated('anim_spin:a=x:w=1.4' + tag, (x0 + 0.66 * k * c, cy, z0 - 0.66 * k * s), yaw):   # the wheel turns
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
    if yaw:                                                                      # built facing +X, then turned
        bpy.context.view_layer.update()
        turn = Matrix.Translation(P(x0, 0, z0)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Translation(-P(x0, 0, z0))
        for o in bpy.context.scene.objects:
            if o not in before and o.parent is None:
                o.matrix_world = turn @ o.matrix_world

@piece(1.0)
@plain
def windpump():
    # Crag: a windpump out on the range, a tree's height, its wheel turning
    # (toward +X, the road) over the round stock tank it fills, and the
    # ranch's cattle come in to it: one drinking at the tank, the rest
    # grazing round it, two of them now and then lifting their heads to look
    # about (a gesture). The herd stands at the water rather than alone on
    # the range, where four cows a car long each are a speck from the road:
    # tower, tank and herd read as one scene.
    windpump_body(0.0, 0.0, 0.5)                                                 # a big one, some 16 m
    TX, TZ = 2.0, 1.0
    cyl(0.85, 0.36, (TX, 0, TZ), 'grey', segs=12)                              # the stock tank
    cyl(0.78, 0.04, (TX, 0.33, TZ), 0x62d3c8, segs=12)
    box((0.3, 0.24, 0.3), (-0.9, 0.12, 1.4), 'white')                           # the salt lick
    def toward(x, z, tx, tz):
        return math.atan2(-(tz - z), tx - x)
    cow((3.4, 0, 0.0), yaw=toward(3.4, 0.0, TX, TZ))                           # drinking
    cow((0.2, 0, 2.1), yaw=0.3, life='anim_sway:a=z:d=32:p=7.4:r=0.74#a')
    cow((2.8, 0, 2.3), yaw=2.4, coat=0xf8f8fb, life='anim_sway:a=z:d=28:p=9.2:r=0.78#b')
    cow((-1.4, 0, -1.5), yaw=-0.9, coat=0x5a3a28)
    join_still('pump')

def cow(at, yaw=0.0, coat=0x8a5a3c, life=None):
    """A cow the size of one beside a car (about a car long), facing +X
    turned by `yaw`: a block of a body on its legs, a white patch, a white
    face lowered to graze, short horns. `life` names the head's motion,
    hinged at the neck: a gesture (a sway with a rest) lifts it from the
    grass to look about now and then and lowers it again."""
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

# Crag stands the ranch with its +X 39.1 degrees round from the world's +X
# (its placement's heading); the world's west is this far round from it.
RANCH_WIND_YAW = math.pi - 0.682

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
    # the windpump over the stock tank, across the yard. Its wheel faces the
    # wind that blows the sand east across every canyon map (the ambient's
    # +X drift, the clouds' too), so it looks west: RANCH_WIND_YAW turns it
    # from the ranch's +X (the road) as Crag stands it (tracks.js crag set).
    windpump_body(1.6, 6.8, 0.42, tag='#w', yaw=RANCH_WIND_YAW)
    wx, wz = 1.6 + math.cos(RANCH_WIND_YAW), 6.8 - math.sin(RANCH_WIND_YAW)
    cyl(0.75, 0.32, (wx, 0, wz), 'grey', segs=12)
    cyl(0.68, 0.04, (wx, 0.3, wz), 0x62d3c8, segs=12)
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
    cow((1.7, 0, 0.9), yaw=2.6, coat=0x5a3a28, life='anim_sway:a=z:d=32:p=8.6:r=0.74#c')
    cow((2.2, 0, -1.2), yaw=-1.2, coat=0xf8f8fb)
    join_still('ranch')

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
    # sign by the road turning on its pole (anim_spin). A hawk circles over it.
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
    hawk_circle((0.4, -0.6), 4.6, 3.6, 14.0)
    join_still('station')

def pumpjack(x0, z0, yaw, tag, period):
    """An oil pumpjack, the nodding donkey, its beam along its local X turned
    by `yaw`: a skid, the A-frame samson post, the walking beam with the
    horsehead over the wellhead at +X and the gearbox with its red
    counterweights at -X. The beam and the horsehead nod (anim_sway about
    the beam's pivot), the bridle hanging from the head riding with them into
    the wellhead's stuffing box, and the pitman arms hanging from the far end
    riding with them down beside the counterweights, so the beam reads as
    driven. Two units tall, a real one's height and a half."""
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x0 + dx * c + dz * s, dy, z0 - dx * s + dz * c)
    def part(size, dx, dy, dz, color, pitch=0.0):
        box(size, at(dx, dy, dz), color, yaw=yaw, pitch=pitch)
    part((2.9, 0.14, 0.8), -0.1, 0.07, 0, 'grey')                               # the skid
    for sx in (-1, 1):                                                          # the samson post
        for sz in (-1, 1):
            strut(at(sx * 0.42, 0.1, sz * 0.34), at(0, 1.5, sz * 0.12), 0.1, 'slate')
    part((0.5, 0.56, 0.5), -1.05, 0.42, 0, 'slate')                             # the gearbox
    for sz in (-1, 1):
        part((0.6, 0.34, 0.08), -1.05, 0.46, sz * 0.32, 'red')                  # its counterweights
    part((0.26, 0.5, 0.26), 1.32, 0.25, 0, 'slate')                             # the wellhead
    part((0.36, 0.1, 0.36), 1.32, 0.52, 0, 'grey')
    with animated('anim_sway:a=z:d=16:p=%.1f#%s' % (period, tag), at(0, 1.6, 0), yaw):
        part((2.6, 0.16, 0.16), -0.05, 1.6, 0, 'slate')                         # the walking beam
        part((0.2, 0.62, 0.22), 1.28, 1.42, 0, 'yellow')                        # the horsehead
        part((0.12, 0.1, 0.22), 1.36, 1.76, 0, 'yellow')
        part((0.06, 0.66, 0.06), 1.36, 0.88, 0, 'dark')                         # the bridle
        part((0.3, 0.22, 0.24), -1.28, 1.56, 0, 'slate')                        # the equalizer
        part((0.12, 0.1, 0.96), -1.2, 1.48, 0, 'slate')                         # its cross bar
        for sz in (-1, 1):                                                      # the pitman arms, down to
            part((0.08, 1.0, 0.08), -1.2, 0.98, sz * 0.44, 'dark')              # the cranks

@piece(1.0)
def oil_field():
    # Sidewinder: a little oil field on the desert by the highway, every
    # piece at its own size beside a car: three pumpjacks on their dirt pads,
    # out of step, nodding (anim_sway); a pair of tanks; and tumbleweeds
    # blowing along the field's road side (+X), bouncing as they roll, out of
    # a rock pile at one end and into one at the other (anim_path+spin+bob,
    # home under the ground). The jacks stand broadside to the road (beams
    # along Z), the way a nod reads.
    PADS = ((-1.0, -6.5, 4.6), (-3.4, 0.4, 5.3), (-0.6, 6.8, 4.1))
    for n, (x, z, per) in enumerate(PADS):
        ground_poly([(x - 1.4, 0.03, z - 2.2), (x + 1.4, 0.03, z - 2.2), (x + 1.4, 0.03, z + 2.2),
                     (x - 1.4, 0.03, z + 2.2)], [(0, 1, 2, 3)], 0xb8a686)
        pumpjack(x, z, math.pi / 2 * (1 if n % 2 else -1), 'j%d' % n, per)
    # the tank battery the jacks pump into, a real lease tank's size (some
    # seven metres across and as tall), white and red, the field's mass
    with plain_parts():
        for k, (x, z) in enumerate(((-6.6, 3.0), (-6.6, 5.4))):
            cyl(1.0, 1.5, (x, 0, z), 'white' if k else 'red', segs=12)
            cyl(1.04, 0.1, (x, 1.5, z), 'slate', segs=12)
        box((0.12, 0.12, 1.4), (-6.6, 1.2, 4.2), 'slate')                       # their pipe
    # the old timber derrick the field was struck with, still standing over
    # its well behind the jacks: a cable-tool rig's height (about 22 m), its
    # four legs leaning in to the crown block, girts and braces up its faces,
    # the bull-wheel shed at its foot; the field's mark from across the map
    DX, DZ, DH = -6.4, -2.4, 5.0
    def leg(sx, sz, y):
        w = 0.95 + (0.28 - 0.95) * y / DH
        return (DX + sx * w, y, DZ + sz * w)
    with plain_parts():
        for sx in (-1, 1):
            for sz in (-1, 1):
                strut(leg(sx, sz, 0.0), leg(sx, sz, DH), 0.14, TIMBER)
        lv = (0.3, 1.5, 2.6, 3.6, 4.4)
        for y in lv:                                                             # the girts
            w = 0.95 + (0.28 - 0.95) * y / DH
            for s in (-1, 1):
                box((2 * w + 0.1, 0.1, 0.1), (DX, y, DZ + s * w), TIMBER)
                box((0.1, 0.1, 2 * w + 0.1), (DX + s * w, y, DZ), TIMBER)
        for y0, y1 in zip(lv, lv[1:]):                                           # a brace up each face
            for a, b in (((1, 1), (1, -1)), ((-1, -1), (-1, 1)), ((1, -1), (-1, -1)), ((-1, 1), (1, 1))):
                strut(leg(*a, y0), leg(*b, y1), 0.07, TIMBER)
        box((0.9, 0.3, 0.9), (DX, DH + 0.15, DZ), TIMBER)                        # the crown block
    hut(1.6, 0.9, 1.3, (DX + 0.2, 0, DZ - 2.1), 0x9a7b55, 'slate', t=0.5)
    # the weeds' run along the road side
    L, R, X = 26.0, 0.25, 2.2
    for sz in (-1, 1):
        sandstone_rock((X + 0.3, 0, sz * (L / 2 + 0.6)), 1.0, yaw=0.5 + sz)
    zs = [-L / 2 + L * i / 12 for i in range(13)]
    for k, pt in enumerate([(X, R, z) for z in zs] + [(X, -1.6, L / 2), (X, -1.6, -L / 2)]):
        marker('path_weeds_%d' % k, pt)
    for n in range(3):
        z = zs[1 + 4 * n]
        with animated('anim_path:c=weeds:p=30:o=%.3f:f=1+spin:a=z:w=-7.5+bob:h=0.28:p=%.2f:r=0.35#%d'
                      % (n / 3, 0.72 + 0.07 * n, n), (X, R, z)):
            tumbleweed((X, R, z), R)
    join_still('field')

@piece(0.6)
@plain
def headframe():
    # Gulch: the far end of the mine's ore line, where a shaft goes straight
    # down: a timber headframe over the shaft collar at a big real one's
    # height (some thirty metres, eight car lengths, so its wheel shows over
    # the high bend's deck; the builder's units are 1/0.6 of the world's),
    # its back legs braced toward the hoist house (-X) the cable comes from,
    # the sheave wheel on top turning as the cage winds (anim_spin), the
    # cable over it and down to the cage; the ore line (set-ore-line) runs up
    # to the collar from +X, and its train rolls onto the collar and down the
    # shaft. The hoist house's boiler stack stands nearly as tall as the
    # headframe, smoke rising from it (anim_smoke): the working mine's mark
    # on the skyline from across the map.
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
    SX, SZ, SH = -10.0, -2.4, 9.6                                                # its boiler stack
    cyl(0.62, 0.9, (SX, 0, SZ), 0xa96545, segs=8)
    cyl(0.45, SH, (SX, 0, SZ), 'slate', r2=0.36, segs=8)
    cyl(0.48, 0.4, (SX, SH - 0.4, SZ), 0x8a4a32, segs=8)
    marker('anim_smoke:s=2.4', (SX, SH + 0.1, SZ))                              # a stack's smoke, not a chimney's
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

# ---- the playroom ---------------------------------------------------------------
# Indoors the scale is the TOY car's: a racer is a 5 cm toy car, so 1 unit is
# about 5.5 cm, and every toy here stands at its real size beside one (a
# little chunkier, as a toy is): a board game about 11 across, a wooden snake
# as thick as a car is tall, a wind-up robot 5 tall, a castle of blocks 10
# across, a marble run 9 high. Nothing from the grown-ups' world: at this
# scale a book or a sofa is terrain, not a prop.

def slinky():
    # Helix: a rainbow slinky walking down a stack of books (built at the
    # marble tower's grow, 0.65, which stands it beside). ONE coiled wire,
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
        tube(pts[k:k + BAND + 1], WIRE, RAIN[(k // BAND) % 6], res=1, bevel_res=0)
        bpy.ops.object.shade_smooth()

@piece(0.8)
def block_castle():
    # Gauntlet: a castle of alphabet blocks on the floor, the toy siege the
    # track's soldiers and robot lay. The curtain wall runs along the road
    # with its gate to the road (+X), towers at the four corners flying
    # pennants that flap, the king's banner over the gate, side and back
    # walls closing the court, a moat along the front with the drawbridge
    # down across it. A block is about 5 cm; a pennant a toy's, cut big
    # enough to see flapping from the road.
    S, C = 1.4, 0.0                               # a block; the ground it stands on
    front = ('+x', '+y')
    for i in range(7):                           # the curtain wall, two courses
        z = (i - 3) * S
        if i != 3:
            block(S, (0, C + S / 2, z), TOY[(i + 1) % 4], faces=front, letters={'+x': ABC[i]})
        block(S, (0, C + S * 1.5, z), TOY[i % 4], faces=front)
        if i % 2 == 0:
            box((S * 0.6, S * 0.5, S * 0.6), (0, C + S * 2.25, z), 0xf2c14e)
    box((0.5, S * 1.05, S * 0.9), (0.2, C + S * 0.52, 0), 0x3a2a22)              # the gateway
    GT = C + S * 2                                                              # the banner over it
    box((BAR * 1.6, 2.6, BAR * 1.6), (0, GT + 1.3, 0), 0x2a2735)
    with animated('anim_sway:a=x:d=20:p=2.4#banner', (0, GT + 2.55, 0)):
        box((0.08, 1.1, 1.9), (0, GT + 1.98, 1.0), 0x5a8fd8)
        box((0.1, 0.4, 0.4), (0, GT + 1.98, 1.0), 0xf2c14e)                    # its crest
    n = 0
    for sz in (-1, 1):
        z = sz * 4 * S
        for x, h in ((0, 3), (-3 * S, 2)):          # front and rear towers
            for j in range(h):
                block(S, (x, C + S / 2 + j * S, z), TOY[(j + sz + 2) % 4], faces=('+x', '+z', '-z', '-x'),
                      letters={'+x': ABC[(j + 4 + sz) % 8]} if x == 0 else None)
            top = C + h * S
            cyl(S * 0.78, S * 0.9, (x, top, z), 0x6cbf6c if x == 0 else 0xe66a5a, r2=0.05, segs=10)
            box((BAR * 1.4, 1.8, BAR * 1.4), (x, top + 1.3, z), 0x2a2735)
            with animated('anim_sway:a=x:d=24:p=%.1f#%d' % (1.6 + 0.2 * n, n), (x, top + 2.15, z)):
                box((0.08, 0.8, 1.2), (x, top + 1.75, z + 0.65 * sz), 0xff5040)  # the pennant flaps,
                box((0.08, 0.44, 0.6), (x, top + 1.75, z + 1.5 * sz), 0xff5040)  # tapering to its tip
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
    merge_paint()

@piece(0.45)
def spinning_top():
    # Helix: a tin humming top (about 16 cm across and 20 cm to its knob, the
    # biggest tops there are) spinning on its point, the screw of its pump a
    # helix of its own, and a wooden top (about 6 cm) spinning beside it with
    # its pull string thrown down on the floor. Each PRECESSES as a top does:
    # it spins fast about its own axis, leaned off upright, and that axis
    # walks slowly round the upright on its point, the same way round (a
    # leaned spin riding an upright one). The wooden one is further run down:
    # leaned more, its axis circling faster. The point is the upright part:
    # a part with nothing drawn is no node for the lean to ride.
    with animated('anim_spin:w=1.5#a', (0, 0, 0)):
        cyl(0.15, 0.6, (0, 0, 0), 0x2a2735, r2=0.6, segs=8)                          # the point
        with animated('anim_spin:w=5.0#a', (0, 0, 0), tilt=0.12):
            humming_top_body()
    x, z, k = -1.5, 6.4, 0.75
    with animated('anim_spin:w=-2.6#b', (x, 0, z)):
        cyl(0.06 * k, 0.4 * k, (x, 0, z), 0x2a2735, r2=0.32 * k, segs=10)
        with animated('anim_spin:w=-7.0#b', (x, 0, z), tilt=0.2):
            spinning_top_body(x, z, k)
    tube([(-0.5, 0.1, 4.6), (-0.2, 0.1, 3.8), (0.9, 0.1, 3.9), (1.9, 0.1, 4.6), (2.6, 0.1, 4.2)], 0.05, 0xfff6eb, res=3, bevel_res=0)
    box((0.3, 0.3, 1.4), (2.9, 0.15, 3.9), 0x9a7b55, yaw=0.9)

def humming_top_body():
    # tin: a cone up from the point to a fat yellow belly band, a painted dome
    # over it with panels that show it turning, the collar, and the pump: a
    # bar with its screw wound round it and a red knob
    cyl(0.6, 1.6, (0, 0.6, 0), 0xe66a5a, r2=3.3, segs=10)
    cyl(3.4, 0.5, (0, 2.2, 0), 0xf2c14e, segs=10)
    cyl(3.3, 1.6, (0, 2.7, 0), 0x5a8fd8, r2=1.4, segs=10)
    for j in range(6):
        a = j * math.pi / 3
        box((0.16, 1.4, 1.0), (math.cos(a) * 2.5, 3.45, math.sin(a) * 2.5), (0xfdf4de, 0xe66a5a)[j % 2], yaw=-a, roll=-0.87)
    cyl(1.4, 0.4, (0, 4.3, 0), 0xf2c14e, r2=0.8, segs=10)
    box((0.4, 3.2, 0.4), (0, 6.2, 0), 0x9aa1b4)
    tube(helix_pts(0, 0, 0.36, 4.8, 7.4, 0.0, 3, per=5), 0.08, 0x9aa1b4, res=1, bevel_res=0)
    cyl(0.8, 0.7, (0, 7.7, 0), 0xe66a5a, r2=0.55, segs=10)

def spinning_top_body(x, z, k):
    cyl(0.32 * k, 1.2 * k, (x, 0.4 * k, z), 0xe66a5a, r2=1.7 * k, segs=10)          # the belly
    cyl(1.76 * k, 0.32 * k, (x, 1.6 * k, z), 0xffc044, segs=10)                      # the rim
    cyl(1.7 * k, 0.75 * k, (x, 1.92 * k, z), 0x5a8fd8, r2=0.95 * k, segs=10)         # the shoulder
    cyl(0.95 * k, 0.25 * k, (x, 2.67 * k, z), 0xffc044, r2=0.55 * k, segs=10)        # the crown
    box((0.34 * k, 1.2 * k, 0.34 * k), (x, 3.4 * k, z), 0x9a7b55)                    # the handle
    box((0.52 * k, 0.4 * k, 0.52 * k), (x, 4.1 * k, z), 0x6cbf6c)
    for y in (0.93, 1.35) if k == 1 else ():      # stripes hugging the big one's belly
        torus((0.32 + 1.38 * (y - 0.4) / 1.2 + 0.03) * k, 0.05, (x, y * k, z), 0xfdf4de, segs=10)
    for j in range(4):                            # bands round the shoulder: they show it turning
        a = j * math.pi / 2
        box((0.5 * k, 0.7 * k, 0.14 * k), (x + math.cos(a) * 1.35 * k, 2.3 * k, z + math.sin(a) * 1.35 * k), 0xe66a5a, yaw=-a)

@piece(0.7)
def toy_robot():
    # Gauntlet: a boxy wind-up robot marching its beat before the castle, a
    # loop so it never turns back on itself in sight: it steps as wind-up
    # toys walk, each leg lifting in turn while the body rocks over the other
    # (anim_bob and anim_waddle in step), and the big key in its back turns.
    # Visor and eyes, a grille mouth, antenna, claws. Built facing +X at the
    # loop's first point; the renderer turns it along its way. About 25 cm
    # tall.
    RX, RZ, N = 1.6, 4.0, 16
    for k in range(N):
        a = 2 * math.pi * k / N
        marker('path_patrol_%d' % k, (RX * math.cos(a), 0, RZ * math.sin(a)))
    X = RX
    with animated('anim_path:c=patrol:p=14:f=1', (X, 0, 0)):
        box((1.2, 0.45, 1.9), (X, 1.9, 0), 0x868ba1)                             # the hips march on
        # a leg lifts at the top of the body's rock the other way: the waddle
        # rolls its top toward +Z a quarter in, so the -Z leg goes up then
        for z, o in ((-0.55, 0.25), (0.55, 0.75)):
            with animated('anim_bob:h=0.24:p=0.9:o=%g#%s' % (o, 'l' if z < 0 else 'r'), (X, 0, z)):
                box((0.7, 1.4, 0.7), (X, 1.0, z), 0x9aa1b4)
                box((1.1, 0.3, 0.9), (X + 0.1, 0.15, z), 0x2a2735)
        with animated('anim_waddle:d=7:p=0.9:o=0', (X, 1.9, 0)):                  # the body rocks over them
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
# Each playroom track is one game laid out on the floor (the pieces are built
# in world units, a car 0.9 long, so their GROW is 1): Skysnake snakes and
# ladders, Skyline a town of wooden blocks, Helix a marble run, Gauntlet a
# block castle under siege.

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

def print_band(pts, y, w, color):
    """A flat printed band `w` wide along the points [(x, z)] at height `y`:
    a snake or a ladder's rail drawn on the board."""
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        l = math.hypot(x1 - x0, z1 - z0) or 1.0
        nx, nz = -(z1 - z0) / l * w / 2, (x1 - x0) / l * w / 2
        quad([(x0 - nx, y, z0 - nz), (x1 - nx, y, z1 - nz), (x1 + nx, y, z1 + nz), (x0 + nx, y, z0 + nz)], color)

def print_ladder(a, b, w, y, color):
    """A ladder printed on the board from (x, z) a to b, `w` wide."""
    l = math.hypot(b[0] - a[0], b[1] - a[1])
    nx, nz = -(b[1] - a[1]) / l * w / 2, (b[0] - a[0]) / l * w / 2
    for s in (-1, 1):
        print_band([(a[0] + s * nx, a[1] + s * nz), (b[0] + s * nx, b[1] + s * nz)], y, 0.14, color)
    n = max(2, int(l / 0.45))
    for k in range(1, n):
        f = k / n
        cx, cz = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
        print_band([(cx - nx, cz - nz), (cx + nx, cz + nz)], y + 0.002, 0.1, color)

def keep_light(below):
    """A print on the floor (a board's squares, a rug's streets) keeps its
    colour: shade() would grey everything under a piece's tall parts as if
    it were the foot of a wall. Every part whose top is under `below`."""
    bpy.context.view_layer.update()
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and max((o.matrix_world @ v.co).z for v in o.data.vertices) < below:
            o['ramp'] = 0.15

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

def stand_open(B, phi):
    """Stand a folded board up like an open book: every part so far, built
    lying flat (face up, its fold the line x = 0), is cut at the fold and
    turned so the fold stands upright, the board's -Z edge on the floor and
    its face to +X, each half swung `phi` toward the face."""
    import bmesh
    bpy.ops.object.select_all(action='DESELECT')
    parts = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    c, s = math.cos(phi), math.sin(phi)
    for o in parts:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                               plane_co=(0, 0, 0), plane_no=(1, 0, 0))
        for v in bm.verts:
            x, y, z = v.co.x, v.co.z, -v.co.y                  # Blender -> (across, up, along)
            h, d = z + B, y                                    # stood on its -Z edge, face to +d
            sg = 1.0 if x > 0 else -1.0
            x, d = x * c - sg * d * s, sg * x * s + d * c      # each half swung toward the face
            v.co = P(d, h, x)
        bm.to_mesh(o.data)
        bm.free()
        o.data.update()

@piece(1.0)
def snakes_ladders():
    # Skysnake: a game of snakes and ladders past the dive's loop, outside
    # the bend the loop runs out into: a 60 cm board of a hundred squares (a
    # toy car fits on one) stood up half open like a book, its snakes and
    # ladders to the road (lying flat, it showed only a sliver over the
    # kerb), the pawns and two dice on the floor before it. The track's dive
    # is its snake and its climb a ladder.
    B, T = 5.5, 0.22
    box((2 * B + 0.25, T, 2 * B + 0.25), (0, T / 2, 0), 0xb06041)        # the board's edge
    box((2 * B, 0.04, 2 * B), (0, T + 0.02, 0), 0xfdf4de)                 # its printed face
    C = 2 * B / 10
    y = T + 0.06
    for i in range(10):
        for j in range(10):
            if (i + j) % 2:
                continue
            x0, z0 = -B + i * C, -B + j * C
            quad([(x0, y, z0), (x0 + C, y, z0), (x0 + C, y, z0 + C), (x0, y, z0 + C)], TOY[((i + j) // 2 + j) % 4])
    # the printed ladders and snakes
    for a, b in (((2.4, -4.1), (3.5, 1.4)), ((-4.6, -4.4), (-4.1, -0.6)), ((1.6, 2.0), (2.8, 4.8))):
        print_ladder(a, b, 0.75, y + 0.01, 0xb06041)
    for ctrl, c in (([(-2.5, 4.4), (-0.9, 3.0), (-2.6, 1.3), (-0.8, -0.5), (-1.6, -2.4)], 0x6cbf6c),
                    ([(4.6, 4.3), (3.6, 3.0), (4.6, 1.2), (4.0, -1.0)], 0xe66a5a),
                    ([(0.6, -1.2), (1.4, -2.4), (0.2, -3.4), (1.0, -4.7)], 0xa878e8)):
        pts = curve(ctrl, 0.3)
        print_band(pts, y + 0.02, 0.42, c)
        hx, hz = ctrl[0]
        quad([(hx - 0.35, y + 0.025, hz), (hx, y + 0.025, hz - 0.3), (hx + 0.35, y + 0.025, hz), (hx, y + 0.025, hz + 0.45)], c)
    keep_light(0.4)
    stand_open(B + 0.125, math.radians(28))
    pawn((3.4, 0, -1.2), 0xe66a5a, k=0.4)
    pawn((4.2, 0, 0.6), 0x5a8fd8, k=0.4)
    pawn((2.6, 0, 0.3), 0xa878e8, k=0.4)
    pawn((4.6, 0, -2.6), 0xf2c14e, k=0.4)
    die((5.4, 0, 1.6), 0.6, 0.4)
    die((5.9, 0, 0.4), 0.6, -0.3, faces=(('+x', 1), ('-z', 6), ('+z', 3), ('-x', 4)))
    merge_paint()

def toy_snake(ctrl, base, k, rear=None, tail=None, neck=None):
    """A jointed wooden toy snake lying along the curve through `ctrl` [(x,
    z)], its blocks alternating green and yellow with a gap at every joint,
    tapering to the tail, `k` its size, standing on `base(x, z)`. With `rear`
    (a direction (x, z)), its last joints rise and its head leans out that
    way; otherwise its head lies at the curve's end. `neck` names the rearing
    neck's motion (anim_), with its head. `tail` (n, degrees, period, lag)
    wiggles the tail's last n blocks the way the toy's joints let it: each
    block swings about the joint before it, riding the one before, each `lag`
    of a swing behind the one before (anim_sway in step), so a wave runs down
    to the tip."""
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
        n, deg, period, lag = tail
        with contextlib.ExitStack() as chain:
            for m in range(n):
                j = joints[n - m]
                chain.enter_context(animated('anim_sway:a=y:d=%g:p=%g:o=%.3f#tail%d' % (deg, period, (1.0 - m * lag) % 1.0, m),
                                             (j[0], base(*j), j[1])))
                body(n - 1 - m)
    for i in range(0 if not tail else tail[0], N - 1):
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
    with animated(neck, (nx, y0, nz)) if neck else contextlib.nullcontext():
        for i in range(len(NECK) - 1):
            (h0, a0), (h1, a1) = NECK[i], NECK[i + 1]
            bar((nx + d[0] * h0 * k, y0 + a0 * k, nz + d[1] * h0 * k), (nx + d[0] * h1 * k, y0 + a1 * k, nz + d[1] * h1 * k),
                1.15 * k, 1.05 * k, SNAKE[(N + i) % 2])
        head(nx + d[0] * 3.1 * k, y0 + 5.75 * k, nz + d[1] * 3.1 * k, d, -0.12)

@piece(1.0)
def jointed_snake():
    # Skysnake's hero: the board's snake come alive, a wooden jointed toy
    # snake (about 80 cm of it, as thick as a toy car is tall) lying in curves
    # on the floor inside the bend before the line. It rears up at its -Z end
    # and sways its head out over -X toward the racers coming at it down the
    # straight, and its tail wiggles joint by joint as the wooden toy's
    # does when it is shaken; a little one lies curled beside it. Its body
    # runs along Z.
    toy_snake([(0.0, 7.4), (1.6, 5.0), (-1.6, 2.6), (1.4, 0.0), (-1.3, -2.4), (0.9, -4.6), (0.0, -6.4)],
              lambda x, z: 0.0, 0.62, rear=(-1.0, 0.0),
              tail=(5, 10, 2.2, 0.13), neck='anim_sway:a=y:d=24:p=3.3#neck')
    toy_snake([(-3.4, 7.8), (-4.6, 5.8), (-3.4, 4.0), (-4.5, 2.2)], lambda x, z: 0.0, 0.36)

@piece(1.0)
def toy_snake_loop():
    # Skysnake: another of the game's wooden snakes slithering round on the
    # floor. Its body lies on an arc of its circle and it travels round the
    # circle head first (anim_path, facing its way), so every block follows
    # the one ahead along the curve, as a snake's body does. A traveller,
    # it leaves the sun bake: a shadow baked where it lay would stay behind.
    # Its head rears up as it goes, a cobra's, so it reads over a kerb. As
    # thick as the jointed snake (one game's snakes), on a ring wide enough
    # to read from the straight it lies at the end of. Built with its head at
    # +Z heading +X, where the loop starts.
    R, k, N = 3.4, 0.6, 64
    for i in range(N):
        a = math.radians(90.0 - 360.0 * i / N)
        marker('path_ring_%d' % i, (R * math.cos(a), 0, R * math.sin(a)))
    ctrl = [(R * math.cos(math.radians(a)), R * math.sin(math.radians(a))) for a in range(330, 89, -30)]
    with animated('anim_path:c=ring:p=14:f=1', (0, 0, R)):
        toy_snake(ctrl, lambda x, z: 0.0, k, rear=(1.0, 0.0))

@piece(1.0)
def game_box():
    # Skysnake: the game's box (40 by 26 cm) stood on its edge by the spiral
    # climb, the lid's green snake, its drawn ladders and its yellow title
    # band to the road (+X); a spare die and two pawns left beside it.
    W, H, D = 7.4, 4.8, 1.0
    box((D, H, W), (0, H / 2, 0), 0x5a8fd8)
    plate_x(D / 2 + 0.01, H - 1.35, H - 0.4, -W / 2 + 0.5, W / 2 - 0.5, 0xf2c14e)        # the title band
    tube([(D / 2 + 0.08, 0.65, -2.9), (D / 2 + 0.08, 1.7, -1.3), (D / 2 + 0.08, 0.95, 0.25),
          (D / 2 + 0.08, 2.3, 1.55), (D / 2 + 0.08, 2.85, 2.7)], 0.16, 0x6cbf6c, res=3, bevel_res=0)
    box((0.16, 0.42, 0.58), (D / 2 + 0.08, 2.95, 2.95), 0x6cbf6c)                    # its head
    for z in (-0.65, 1.3):                                                         # the drawn ladders
        for s in (-1, 1):
            plate_x(D / 2 + 0.02, 0.5, 2.75, z + s * 0.37 - 0.07, z + s * 0.37 + 0.07, 0xb06041)
        for y in (0.95, 1.5, 2.05, 2.6):
            plate_x(D / 2 + 0.02, y - 0.05, y + 0.05, z - 0.37, z + 0.37, 0xb06041)
    die((1.6, 0, 2.2), 0.5, 0.5)
    pawn((1.7, 0, -1.4), 0xe66a5a, k=0.3)
    pawn((2.4, 0, -0.6), 0x6cbf6c, k=0.3)
    merge_paint()

# ---- Skyline: a town of wooden blocks ---------------------------------------

WOOD = 0xf2bf99

def mini_car(x, z, color, along_x=False):
    """A toy car the racers' own size (0.9 long), standing on the rug."""
    def P2(a, b):                                   # (across, along) offsets in the car's frame
        return (x + b, z + a) if along_x else (x + a, z + b)
    for (a, b), (w, h, l), y, c in (((0, 0), (0.5, 0.2, 0.9), 0.24, color), ((0, -0.05), (0.44, 0.18, 0.45), 0.43, color),
                                     ((0, 0.19), (0.4, 0.14, 0.05), 0.43, 0x8ecae6)):
        px, pz = P2(a, b)
        box((l, h, w) if along_x else (w, h, l), (px, y, pz), c)
    for sa in (-1, 1):
        for sb in (-1, 1):
            px, pz = P2(sa * 0.25, sb * 0.3)
            box((0.24, 0.24, 0.1) if along_x else (0.1, 0.24, 0.24), (px, 0.15, pz), 0x2a2735)

def house(x, z, w, d, h, body, roof, kind='gable'):
    """A wooden toy house: a painted block, a door and windows to the road
    (+X), a gable roof block (running along X), a flat roof slab or a
    pyramid on top."""
    box((w, h, d), (x, h / 2, z), body)
    plate_x(x + w / 2 + 0.01, 0, min(0.75, h * 0.45), z - 0.22, z + 0.22, 0x3a2a22)
    if h > 1.3:
        for s in (-1, 1):
            plate_x(x + w / 2 + 0.01, h - 0.75, h - 0.35, z + s * d * 0.28 - 0.18, z + s * d * 0.28 + 0.18, 0x8ecae6)
    if kind == 'gable':
        rh = min(w, d) * 0.55
        prism([(z - d / 2 - 0.15, h), (z + d / 2 + 0.15, h), (z, h + rh)], x, w + 0.2, roof)
    elif kind == 'flat':
        box((w + 0.2, 0.3, d + 0.2), (x, h + 0.15, z), roof)
    else:
        cyl(min(w, d) * 0.72, min(w, d) * 0.8, (x, h, z), roof, r2=0.05, segs=4, yaw=math.pi / 4)

def stack_tower(x, z, sizes, colors, cap):
    """A child's tower of stacked blocks, each turned a little, a cone on top."""
    y = 0.0
    for k, s in enumerate(sizes):
        box((s, s, s), (x, y + s / 2, z), colors[k % len(colors)], yaw=0.18 * ((k * 7) % 5 - 2))
        y += s
    cyl(sizes[-1] * 0.55, sizes[-1] * 1.1, (x, y, z), cap, r2=0.05, segs=8)
    return y

@piece(1.0)
def block_city():
    # Skyline: a town of wooden toy blocks built on a city play rug (printed
    # streets, a park, a building site), the racers' own size: houses with
    # gable roofs a block or two tall, a row of shops, a tower a child stacked
    # up to the skyway's height, toy cars parked in the streets, one driving
    # round the park block (anim_path, facing its way), and a toy crane
    # slewing over the building site. The rug is 1.3 by 1.65 m; its front
    # (+X) faces the road, the main street running along it (Z).
    RW, RL = 24.0, 30.0
    box((RW + 0.8, 0.08, RL + 0.8), (0, 0.04, 0), 0x5a8fd8)                     # the rug's border
    box((RW, 0.06, RL), (0, 0.11, 0), 0xfdf4de)                                 # the printed mat
    Y = 0.15
    def street(x0, z0, x1, z1):
        quad([(x0, Y, z0), (x1, Y, z0), (x1, Y, z1), (x0, Y, z1)], 0x868ba1)
    street(0.7, -RL / 2, 3.3, RL / 2)                                             # the main street
    for zc in (-6.0, 7.0):                                                        # and two cross streets
        street(-RW / 2, zc - 1.3, RW / 2, zc + 1.3)
    WX = -11.35                                                                   # a lane down the far edge
    street(-RW / 2, -7.3, -10.7, 8.3)
    for k in range(9):                                                            # dashes down the middle
        z = -RL / 2 + 1.6 + k * 3.4
        quad([(1.9, Y + 0.01, z), (2.1, Y + 0.01, z), (2.1, Y + 0.01, z + 1.2), (1.9, Y + 0.01, z + 1.2)], 0xfdf4de)
    quad([(-10.7, Y, -4.2), (-1.0, Y, -4.2), (-1.0, Y, 5.2), (-10.7, Y, 5.2)], 0x6cbf6c)    # the park
    quad([(-11.5, Y, 9.0), (-3.5, Y, 9.0), (-3.5, Y, 14.5), (-11.5, Y, 14.5)], WOOD)         # the building site
    G = 0.14                                                                      # the rug's top
    B = [  # (x, z, w, d, h, body, roof, kind), the road side first
        (5.0, -12.7, 2.2, 2.0, 1.8, 0xfdf4de, 0xe66a5a, 'gable'), (8.9, -12.6, 2.6, 2.4, 3.4, 0x8ecae6, 0xf2c14e, 'flat'),
        (5.0, -9.3, 2.0, 1.8, 1.4, 0xf2c14e, 0x5a8fd8, 'gable'), (9.4, -9.2, 2.2, 2.0, 1.6, WOOD, 0x6cbf6c, 'pyramid'),
        (5.2, -2.6, 2.4, 2.0, 2.0, WOOD, 0xe66a5a, 'gable'), (5.2, 0.9, 2.0, 2.0, 1.6, 0xfdf4de, 0x6cbf6c, 'gable'),
        (5.2, 4.1, 2.2, 1.8, 2.4, 0xe66a5a, 0xfdf4de, 'flat'), (9.6, -1.6, 3.0, 3.0, 4.6, 0xfdf4de, 0x5a8fd8, 'flat'),
        (9.6, 3.4, 2.4, 2.6, 2.2, 0x8ecae6, 0xe66a5a, 'gable'),
        (5.3, 10.4, 2.2, 2.0, 1.8, 0xf2c14e, 0xe66a5a, 'gable'), (9.4, 10.6, 2.4, 2.4, 2.6, WOOD, 0xa878e8, 'pyramid'),
        (5.5, 13.5, 2.0, 1.8, 1.5, 0xfdf4de, 0x5a8fd8, 'gable'), (9.4, 13.8, 2.4, 2.0, 2.8, 0xe66a5a, 0xf2c14e, 'flat'),
        (-2.4, -12.6, 3.0, 2.6, 5.0, 0xfdf4de, 0xe66a5a, 'flat'), (-6.6, -12.4, 2.4, 2.2, 2.0, WOOD, 0x6cbf6c, 'gable'),
        (-10.0, -12.6, 2.0, 2.0, 1.6, 0xf2c14e, 0xe66a5a, 'gable'), (-3.0, -9.1, 2.2, 1.8, 1.6, 0x8ecae6, 0xa878e8, 'gable'),
        (-8.4, -9.0, 2.6, 2.0, 2.4, 0xe66a5a, 0xfdf4de, 'flat'), (-1.6, 12.6, 2.2, 2.0, 1.8, 0xfdf4de, 0x5a8fd8, 'gable'),
    ]
    for x, z, w, d, h, body, roof, kind in B:
        o0 = set(bpy.context.scene.objects)
        house(x, z, w, d, h, body, roof, kind)
        for o in set(bpy.context.scene.objects) - o0:
            o.location.z += G                                                     # Blender Z is up
    for x, z in ((-9.6, -2.4), (-7.4, 3.6), (-4.0, 4.0), (-3.0, -2.8), (-6.2, -0.6)):   # wooden park trees
        cyl(0.14, 0.7, (x, G, z), 0x9a7b55, segs=6)
        cyl(0.6, 1.5, (x, G + 0.6, z), 0x6cbf6c, r2=0.05, segs=8)
    # the tower a child stacked by the park, up to the skyway
    stack_tower(-9.6, 1.4, (1.3, 1.25, 1.2, 1.15, 1.1, 1.05, 1.0), (0xe66a5a, WOOD, 0x5a8fd8, 0xf2c14e, 0x6cbf6c, 0xfdf4de), 0xff5040)
    # an arch of blocks over the main street
    for s in (-1, 1):
        box((0.7, 1.7, 0.7), (2.0 + s * 1.65, G + 0.85, -4.0), 0xa878e8)
    box((4.1, 0.6, 0.8), (2.0, G + 2.0, -4.0), 0xf2c14e)
    # the building site: loose blocks, and the toy crane lifting one
    for k, (x, z, s, c) in enumerate(((-10.2, 10.0, 0.9, 0xe66a5a), (-9.1, 10.2, 0.9, WOOD), (-9.7, 10.1, 0.9, 0x5a8fd8),
                                      (-10.4, 11.4, 0.8, 0xf2c14e), (-8.0, 13.6, 1.0, 0x6cbf6c))):
        box((s, s, s), (x, G + s / 2 + (0.9 if k == 2 else 0), z), c, yaw=0.3 * k)
    CX, CZ, CH = -6.0, 11.8, 5.6
    box((1.8, 0.4, 1.8), (CX, G + 0.2, CZ), 0x555b66)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.2, CH, 0.2), (CX + sx * 0.32, G + CH / 2, CZ + sz * 0.32), 0xf2c14e)
    for k in range(4):
        box((0.84, 0.14, 0.84), (CX, G + 1.2 + k * 1.3, CZ), 0xf2c14e)
    # The crane slews to and fro over the site's edge and the cross street
    # (its jib toward the town at rest, so the load never swings off the
    # rug), as a crane works, and the block on its hook swings (a pendulum
    # about the jib's own line, riding the jib).
    with animated('anim_sway:a=y:d=45:p=12', (CX, G + CH, CZ)):
        box((1.0, 0.9, 1.0), (CX, G + CH + 0.45, CZ), 0xff5040)                   # the cab
        box((0.45, 0.4, 5.4), (CX, G + CH + 1.05, CZ - 1.9), 0xf2c14e)            # the jib
        box((0.9, 0.7, 1.0), (CX, G + CH + 0.8, CZ + 1.3), 0x555b66)              # the counterweight
        with animated('anim_sway:a=z:d=7:p=2.6', (CX, G + CH + 0.85, CZ - 4.2)):
            bar((CX, G + CH + 0.85, CZ - 4.2), (CX, G + CH - 2.0, CZ - 4.2), 0.06, 0.06, 0x2a2735)
            box((0.7, 0.7, 0.7), (CX, G + CH - 2.4, CZ - 4.2), 0x5a8fd8)           # a block on the hook
    for x, z, c, ax in ((2.6, -10.5, 0xff5040, False), (1.4, 9.0, 0x6cbf6c, False)):
        o0 = set(bpy.context.scene.objects)
        mini_car(x, z, c, along_x=ax)
        for o in set(bpy.context.scene.objects) - o0:
            o.location.z += G
    # the blue car drives round the park block: east along the south cross
    # street, up the main street, west along the north one, down the lane,
    # its corners rounded; built at the loop's first point, heading +X
    loop, RC = [], 1.2
    for (ax, az), (bx, bz) in (((WX, -6.0), (2.0, -6.0)), ((2.0, -6.0), (2.0, 7.0)),
                               ((2.0, 7.0), (WX, 7.0)), ((WX, 7.0), (WX, -6.0))):
        l = math.hypot(bx - ax, bz - az)
        dx, dz = (bx - ax) / l, (bz - az) / l
        n = int((l - 2 * RC) / 0.5)
        loop += [(ax + dx * (RC + (l - 2 * RC) * i / n), az + dz * (RC + (l - 2 * RC) * i / n)) for i in range(n)]
        nx, nz = -dz, dx                                                          # the turn is to the left
        cx, cz = bx - dx * RC + nx * RC, bz - dz * RC + nz * RC
        for i in range(6):
            a = math.pi / 2 * i / 6
            loop.append((cx - nx * RC * math.cos(a) + dx * RC * math.sin(a), cz - nz * RC * math.cos(a) + dz * RC * math.sin(a)))
    for i, (x, z) in enumerate(loop):
        marker('path_drive_%d' % i, (x, G, z))
    with animated('anim_path:c=drive:p=30:f=1', (loop[0][0], G, loop[0][1])):
        o0 = set(bpy.context.scene.objects)
        mini_car(loop[0][0], loop[0][1], 0x5a8fd8, along_x=True)
        for o in set(bpy.context.scene.objects) - o0:
            o.location.z += G
    merge_paint()
    keep_light(0.3)

@piece(1.0)
def block_towers():
    # Skyline: towers a child built of wooden blocks beside the skyway, up to
    # its deck (a 50 cm stack), a shorter one with an arch through it and
    # the blocks left over on the floor.
    stack_tower(0.0, 0.0, (1.4, 1.35, 1.3, 1.25, 1.2, 1.15, 1.1, 1.05), (0x5a8fd8, WOOD, 0xe66a5a, 0xf2c14e, 0x6cbf6c, 0xfdf4de), 0xf2c14e)
    stack_tower(-0.6, 3.2, (1.3, 1.2, 1.1, 1.0), (WOOD, 0xa878e8, 0xf2c14e), 0x5a8fd8)
    for s in (-1, 1):                                                             # the arch
        box((0.7, 1.6, 0.7), (-0.4, 0.8, -3.0 + s * 1.2), 0xe66a5a)
    box((0.9, 0.55, 3.2), (-0.4, 1.88, -3.0), 0xfdf4de)
    box((0.7, 0.7, 0.7), (-0.4, 2.5, -3.0), 0x6cbf6c, yaw=0.4)
    for k, (x, z, s, c) in enumerate(((1.6, 1.4, 1.0, 0xf2c14e), (1.9, -1.2, 0.9, WOOD), (1.2, 5.0, 0.9, 0xe66a5a))):
        box((s, s, s), (x, s / 2, z), c, yaw=0.5 * k + 0.2)

def helix_pts(cx, cz, R, y0, y1, a0, turns, per=16):
    n = int(turns * per)
    return [(cx + R * math.cos(a0 + 2 * math.pi * turns * i / n), y0 + (y1 - y0) * i / n,
             cz + R * math.sin(a0 + 2 * math.pi * turns * i / n)) for i in range(n + 1)]

def chute(pts, color, mr, half=0.75, wall=0.55):
    """A marble run's chute: a U channel under the marbles (radius `mr`),
    swept along their line [(x, y, z)]; its inside and outside are separate
    faces so each keeps its own light."""
    n = len(pts)
    verts = []
    for i, p in enumerate(pts):
        a, b = pts[min(i + 1, n - 1)], pts[max(i - 1, 0)]
        tx, tz = a[0] - b[0], a[2] - b[2]
        l = math.hypot(tx, tz) or 1.0
        ox, oz = -tz / l * half, tx / l * half
        y = p[1] - mr - 0.05
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

@piece(0.62)
def marble_run():
    # Helix: a marble run that is the lap in small, about 50 cm tall. Marbles
    # climb a screw round one tower, roll along a high chute to the second,
    # corkscrew down it and run home along the floor: the track's two
    # spirals, its skyway and its run home, so the loop is closed in sight
    # and never needs hiding. Towers on the piece's Z axis, A (up) at +Z, B
    # (down) at -Z.
    ZA, ZB, R, TURNS = 13.0, -13.0, 3.4, 2.5
    MR = 0.62                                    # a marble's radius: a big shooter, chunky enough to read rolling
    LOW, HIGH_A, HIGH_B = MR + 0.07, 14.5, 13.5  # marble centre heights: the low run lies on the floor
    up = helix_pts(0, ZA, R, LOW, HIGH_A, 0.0, TURNS)
    down = helix_pts(0, ZB, R, HIGH_B, LOW, math.pi, TURNS)
    loop = up + down                             # up ends at angle pi (-X side), down ends at 0 (+X)
    # the towers: stacked toy cylinders, a cap on each
    for zc, h in ((ZA, HIGH_A + 1.0), (ZB, HIGH_B + 1.0)):
        cyl(2.2, 0.4, (0, 0, zc), 0x9aa1b4, segs=12)
        n = 5
        for k in range(n):
            cyl(1.25, h / n, (0, 0.4 + k * h / n, zc), TOY[k % 4], segs=10)
        cyl(1.5, 0.5, (0, 0.4 + h, zc), 0xfdf4de, segs=10)
    chute(up, 0xe66a5a, MR)
    chute(down, 0x5a8fd8, MR)
    chute([up[-1], down[0]], 0xf2c14e, MR)        # the high run from A's top to B's
    chute([down[-1], up[0]], 0xf2c14e, MR)        # and the low run home along the floor
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
    seglen = []
    for i in range(len(loop)):
        a, b = loop[i], loop[(i + 1) % len(loop)]
        seglen.append(math.dist(a, b))
    total = sum(seglen)
    COLS = (0x7db8e8, 0xe66a5a, 0x6cbf6c, 0xf2c14e, 0xa878e8, 0xff7e44, 0x5a8fd8, 0xff5040, 0x6cbf6c, 0xf2c14e)
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
        with animated('anim_path:c=marbles:p=18:o=%.4f:f=0#%d' % (m / NM, m), at):
            sphere(MR, at, COLS[m], subdiv=2, flat=False)

@piece(0.65)
def marble_tower():
    # Helix: one more tower of the marble run's kit (about 45 cm), stood
    # where the grid straight points: a column of the same stacked toy
    # cylinders with a chute wound round it in a helix, three marbles
    # rolling down it, into the column's foot and up inside it (out of sight)
    # to the cup on top. Beside it the slinky walks down its books, a helix
    # of its own: the two read as one corner of the room where a slinky
    # alone was a speck. Side by side along X, read from +Z (the slinky's
    # arch faces it).
    slinky()
    K = 0.62 / 0.65                              # the marble run's own size, in this piece's units
    TX = 9.6                                     # the tower's axis, past the slinky's floor stack
    R, MR, TURNS = 3.0 * K, 0.62 * K, 3.25
    LOW, HIGH = MR + 0.07 * K, 13.4 * K
    cyl(2.2 * K, 0.4 * K, (TX, 0, 0), 0x9aa1b4, segs=12)
    h = HIGH + 0.3 * K
    n = 5
    for k in range(n):
        cyl(1.25 * K, h / n, (TX, 0.4 * K + k * h / n, 0), TOY[(k + 2) % 4], segs=10)
    top = 0.4 * K + h
    cyl(1.0 * K, 1.1 * K, (TX, top, 0), 0xfdf4de, r2=2.0 * K, segs=10)        # the cup the marbles come up into
    down = helix_pts(TX, 0, R, HIGH, LOW, 0.0, TURNS)
    chute(down, 0x6cbf6c, MR, half=0.75 * K, wall=0.55 * K)
    foot = (TX + 0.6 * K * math.cos(2 * math.pi * TURNS), LOW, 0.6 * K * math.sin(2 * math.pi * TURNS))
    chute([down[-1], foot], 0xf2c14e, MR, half=0.75 * K, wall=0.55 * K)          # into the column's foot
    for i in range(4, len(down) - 1, 8):                                         # spokes from the column
        p = down[i]
        dx, dz = p[0] - TX, p[2]
        l = math.hypot(dx, dz)
        bar((TX + dx / l * 1.2 * K, p[1] - MR - 0.1 * K, dz / l * 1.2 * K),
            (p[0] - dx / l * 0.7 * K, p[1] - MR - 0.1 * K, p[2] - dz / l * 0.7 * K), 0.3 * K, 0.3 * K, 0x9aa1b4)
    # the loop: down the screw, into the foot, up the column's middle, out
    # of the cup and back to the top of the screw
    loop = down + [foot] + [(TX, LOW + (top - LOW) * j / 6, 0) for j in range(7)] + [(TX, top + 0.5 * K, 0)]
    for k, p in enumerate(loop):
        marker('path_tower_%d' % k, p)
    for m, c in enumerate((0xe66a5a, 0x5a8fd8, 0xf2c14e)):
        at = down[int(len(down) * m / 3)]
        with animated('anim_path:c=tower:p=11:o=%.4f:f=0#%d' % (m / 3, m), at):
            sphere(MR, at, c, subdiv=2, flat=False)

@piece(0.65)
def marble_zigzag():
    # Helix: a third build from the marble run's kit (about 45 cm): two
    # columns of its stacked toy cylinders with straight chutes zigzagging
    # down between them, three marbles rolling the zigzag, through the
    # columns at each turn, into the tall column's foot and up inside it (out
    # of sight) to the cup on top. Unlike the screw tower its face is broad:
    # the zigzag is the XY plane, read from +Z.
    K = 0.62 / 0.65                              # the marble run's own size, in this piece's units
    CR, MR, N = 1.25 * K, 0.62 * K, 6
    XA, XB = -4.4 * K, 4.4 * K                   # the columns' axes: A the tall one, the lift
    LOW, HIGH = MR + 0.47 * K, 13.4 * K
    box((XB - XA + 4.4 * K, 0.4 * K, 4.4 * K), (0, 0.2 * K, 0), 0x9aa1b4)       # the base board
    for x, h, c0 in ((XA, HIGH + 0.3 * K, 1), (XB, HIGH - (HIGH - LOW) / N + 0.9 * K, 3)):
        n = 5
        for k in range(n):
            cyl(CR, (h - 0.4 * K) / n, (x, 0.4 * K + k * (h - 0.4 * K) / n, 0), TOY[(k + c0) % 4], segs=10)
    top = HIGH + 0.3 * K
    cyl(1.0 * K, 1.1 * K, (XA, top, 0), 0xfdf4de, r2=2.0 * K, segs=10)          # the cup the marbles come up into
    cyl(1.5 * K, 0.5 * K, (XB, HIGH - (HIGH - LOW) / N + 0.9 * K, 0), 0xfdf4de, segs=10)   # the short column's cap
    ends = (XA + CR + 0.1 * K, XB - CR - 0.1 * K)
    loop = []
    for i in range(N):
        y0 = HIGH - (HIGH - LOW) * i / N
        y1 = HIGH - (HIGH - LOW) * (i + 1) / N + 0.25 * K
        a, b = (ends if i % 2 == 0 else ends[::-1])
        ramp = [(a, y0, 0), (b, y1, 0)]
        chute(ramp, TOY[i % 4], MR, half=0.75 * K, wall=0.55 * K)
        loop += ramp + [((XB if i % 2 == 0 else XA), y1 - 0.12 * K, 0)]   # through the column at the turn
    # up the tall column's middle, out of the cup, onto the first chute
    loop += [(XA, LOW + (top - LOW) * j / 6, 0) for j in range(1, 7)] + [(XA, top + 0.5 * K, 0)]
    for k, p in enumerate(loop):
        marker('path_zig_%d' % k, p)
    for m, c in enumerate((0xe66a5a, 0x5a8fd8, 0xf2c14e)):
        at = loop[3 * (2 * m)]
        with animated('anim_path:c=zig:p=12:o=%.4f:f=0#%d' % (m / 3, m), at):
            sphere(MR, at, c, subdiv=2, flat=False)

# ---- Gauntlet: the besiegers ----

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
    box((0.58, 0.75, 0.58), (x, y + 2.87, z), 0x2a2735)
    plate_x(x + 0.302, y + 2.66, y + 2.84, z - 0.09, z + 0.09, 0xffc044)
    box((0.14, 1.5, 0.14), (x + 0.06, y + 1.75, z + 0.59), 0x9aa1b4)       # barrel
    box((0.2, 0.6, 0.2), (x + 0.06, y + 0.85, z + 0.59), 0x9a7b55)         # stock, at the hand

@piece(0.55)
def toy_soldiers():
    # Gauntlet: a rank of four wooden soldiers on their stand, 9 cm tall,
    # guarding the road.
    box((1.2, 0.2, 6.4), (0, 0.1, 0), 0x6cbf6c)
    for k in range(4):
        soldier((0, 0.2, -2.25 + k * 1.5), 0xff5040 if k % 2 == 0 else 0x5a8fd8)
    # their toy cannon, run out toward the road
    for s in (-1, 1):
        cyl(0.55, 0.18, (1.6, 0.55, 4.6 + s * 0.6 - 0.09), 0xb06041, segs=8, axis='along')
    box((0.7, 0.5, 1.0), (1.6, 0.7, 4.6), 0x6cbf6c)
    cyl(0.32, 2.0, (0.9, 1.0, 4.6), 0x38383d, r2=0.26, segs=8, axis='across')
    merge_paint()

@piece(0.55)
def siege_tower():
    # Gauntlet: the besiegers' toy siege tower (about 30 cm, a wooden toy at
    # the soldiers' own scale) rolled up on its four wheels, its drawbridge
    # raised against its face (+X, the side it rolls toward: the castle and
    # the road), a pennant flapping over its battlements, and a rank of four
    # soldiers marching before it: the siege's tallest piece, so it reads
    # down a long straight where a rank alone is a speck.
    W, D = 5.4, 5.4                               # its footprint, X by Z
    WOODC, DARK = 0xc8955a, 0x7a5a3a
    for sx in (-1, 1):                            # the wheels, hubs out
        for sz in (-1, 1):
            z = D / 2 if sz > 0 else -D / 2 - 0.6
            cyl(1.1, 0.6, (sx * 1.6, 1.1, z), DARK, segs=10, axis='along')
            cyl(0.4, 0.7, (sx * 1.6, 1.1, z - 0.05), 0xf2c14e, segs=6, axis='along')
    box((W, 0.7, D), (0, 1.45, 0), DARK)                                          # the bed
    box((W, 3.8, D), (0, 3.7, 0), WOODC)                                          # the storeys
    box((W - 0.5, 3.2, D - 0.5), (0, 7.2, 0), WOODC)
    box((W + 0.4, 0.4, D + 0.4), (0, 9.0, 0), DARK)                               # the fighting deck
    for i, (x, z) in enumerate(((-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0))):
        box((0.9, 0.9, 0.9), (x * (W / 2 - 0.25), 9.65, z * (D / 2 - 0.25)), TOY[i % 4])    # battlements
    for y in (1.8, 5.6):                                                          # plank seams round it
        box((W + 0.08, 0.16, D + 0.08), (0, y, 0), DARK)
    for sz in (-1, 1):                                                            # its sides: a brace, a shield
        z = sz * (D / 2 + 0.04)
        bar((-W / 2 + 0.4, 2.1, z), (W / 2 - 0.4, 5.3, z), 0.3, 0.2, DARK)
        bar((-W / 2 + 0.4, 5.3, z), (W / 2 - 0.4, 2.1, z), 0.3, 0.2, DARK)
        zu = sz * (D - 0.5) / 2                                                   # on the upper storey
        cyl(1.1, 0.2, (0, 7.2, zu if sz > 0 else zu - 0.2), 0x5a8fd8, segs=10, axis='along')
        cyl(0.4, 0.3, (0, 7.2, zu if sz > 0 else zu - 0.3), 0xf2c14e, segs=6, axis='along')
    # the drawbridge, raised: a red board hinged at the upper storey's floor,
    # leaning a little off the face, its two chains up to the deck
    box((0.3, 3.4, 3.4), (W / 2 + 0.2, 7.3, 0), 0xe66a5a, roll=-0.08)
    for z in (-1.0, 0.0, 1.0):
        box((0.12, 3.2, 0.12), (W / 2 + 0.38, 7.3, z), 0xa84a3e, roll=-0.08)
    for sz in (-1, 1):
        bar((W / 2 + 0.45, 8.9, sz * 1.5), (W / 2 - 0.1, 9.1, sz * 1.5), 0.2, 0.2, 0x2a2735)
    box((BAR * 1.6, 3.7, BAR * 1.6), (0, 11.05, 0), 0x2a2735)                    # the pennant's pole
    with animated('anim_sway:a=x:d=24:p=1.9#pennant', (0, 12.8, 0)):
        box((0.08, 0.9, 1.6), (0, 12.35, 0.85), 0x6cbf6c)
        box((0.08, 0.5, 0.8), (0, 12.35, 2.0), 0x6cbf6c)
    # the rank before it, on their stand
    box((1.2, 0.2, 6.4), (W / 2 + 2.6, 0.1, 0), 0x6cbf6c)
    for k in range(4):
        soldier((W / 2 + 2.6, 0.2, -2.25 + k * 1.5), 0xff5040 if k % 2 == 0 else 0x5a8fd8)
    merge_paint()

@piece(0.55)
def trebuchet():
    # Gauntlet: the besiegers' toy trebuchet (about 40 cm to its arm's tip, a
    # wooden kit at the soldiers' own scale) on its wheeled frame, its arm
    # just thrown and standing high over the frame, the sling's red ball at
    # its tip, the counterweight swung down; its crew of three before it. The
    # arm swings in the YZ plane, so it reads side on, from +X (the crew's
    # side).
    WOODC, DARK = 0xc8955a, 0x7a5a3a
    for sx in (-1, 1):
        box((0.6, 0.6, 9.0), (sx * 2.2, 0.9, 0), DARK)                        # the frame's rails
        for z in (-3.6, 3.6):                                                 # its wheels, hubs out
            cyl(0.9, 0.5, (sx * 2.75, 0.9, z), DARK, segs=10, axis='across')
            cyl(0.35, 0.6, (sx * 2.8, 0.9, z), 0xf2c14e, segs=6, axis='across')
        bar((sx * 2.2, 1.2, -3.4), (sx * 2.2, 7.4, 0), 0.55, 0.55, WOODC)     # the A of each side
        bar((sx * 2.2, 1.2, 3.4), (sx * 2.2, 7.4, 0), 0.55, 0.55, WOODC)
        bar((sx * 2.2, 3.4, -2.2), (sx * 2.2, 3.4, 2.2), 0.4, 0.4, DARK)      # and its cross bar
    for z in (-4.0, 4.0):
        box((5.0, 0.5, 0.6), (0, 0.9, z), DARK)                               # the frame's ends
    cyl(0.35, 5.4, (-2.7, 7.4, 0), 0x9aa1b4, segs=8, axis='across')           # the axle
    tip = (0, 7.4 + 7.6 * math.sin(math.radians(66)), 7.6 * math.cos(math.radians(66)))
    tail = (0, 7.4 - 2.6 * math.sin(math.radians(66)), -2.6 * math.cos(math.radians(66)))
    bar(tail, tip, 0.6, 0.6, 0xe66a5a)                                        # the throwing arm, thrown
    box((2.4, 2.0, 2.0), (0, tail[1] - 1.1, tail[2]), 0x5a8fd8)               # the counterweight, swung down
    sling = (0, tip[1] - 2.2, tip[2] + 0.9)
    bar(tip, sling, 0.12, 0.12, 0xfdf4de)
    sphere(0.6, sling, 0xff5040)                                              # the ball in the sling
    # the crew before it, on their stand
    box((1.2, 0.2, 4.6), (4.6, 0.1, 0), 0x6cbf6c)
    for k in range(3):
        soldier((4.6, 0.2, -1.5 + k * 1.5), 0xff5040 if k % 2 == 0 else 0x5a8fd8)
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
