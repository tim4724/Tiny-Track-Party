# Headless Blender half of scripts/slim-kit-models.mjs: import a GLB, weld,
# collapse-decimate to a ratio, export the GEOMETRY. The caller grafts the
# original materials back, so nothing Blender writes about materials or images
# ships.
#   blender -b -P decimate.py -- in.glb out.glb ratio
import sys, bpy
argv = sys.argv[sys.argv.index('--') + 1:]
src, dst, ratio = argv[0], argv[1], float(argv[2])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
o = bpy.context.view_layer.objects.active
# The kit splits a corner per face; collapse needs the welded topology.
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=1e-4)
bpy.ops.object.mode_set(mode='OBJECT')
m = o.modifiers.new('dec', 'DECIMATE')
m.decimate_type = 'COLLAPSE'
m.ratio = ratio
m.use_collapse_triangulate = True
bpy.ops.object.modifier_apply(modifier='dec')
# Coplanar triangles back into n-gons. Without it a collapse across two lumps
# that overlap (a heap of snowballs) leaves faces lit from behind, black.
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.dissolve_limited(angle_limit=0.035, delimit={'UV', 'MATERIAL'})
bpy.ops.object.mode_set(mode='OBJECT')
# Smooth with hard edges past 50 degrees: corners are shared where the kit's
# own look is smooth and split only along real creases and UV seams. A flat
# export spends three vertices on every triangle, which undoes the decimation.
bpy.ops.object.shade_smooth_by_angle(angle=0.87)
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', use_selection=False,
                          export_image_format='NONE', export_materials='EXPORT',
                          export_yup=True, export_apply=True)
