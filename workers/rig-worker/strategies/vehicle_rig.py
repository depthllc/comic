"""Create a rigid, skinned vehicle armature from separately named GLB parts.

This fails when the source generator did not produce distinguishable chassis and
wheel objects; Comic30 must not label a monolithic mesh as a production vehicle rig.
"""
import argparse
import re
import sys
import bpy
from mathutils import Vector


def normalized(value):
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def parse_args():
    values = sys.argv[sys.argv.index("--") + 1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args(values)


def find_part(objects, aliases):
    for obj in objects:
        name = normalized(obj.name)
        if any(normalized(alias) in name for alias in aliases):
            return obj
    return None


args = parse_args()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=args.input)
meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
parts = {
    "chassis": find_part(meshes, ["chassis", "vehiclebody", "carbody", "body"]),
    "wheel_front_left": find_part(meshes, ["wheelfrontleft", "frontleftwheel", "wheelfl"]),
    "wheel_front_right": find_part(meshes, ["wheelfrontright", "frontrightwheel", "wheelfr"]),
    "wheel_rear_left": find_part(meshes, ["wheelrearleft", "rearleftwheel", "wheelrl"]),
    "wheel_rear_right": find_part(meshes, ["wheelrearright", "rearrightwheel", "wheelrr"]),
}
missing = [name for name, obj in parts.items() if obj is None]
if missing:
    raise RuntimeError("Vehicle source requires separately named chassis and wheels; missing: " + ", ".join(missing))

armature_data = bpy.data.armatures.new("Comic30VehicleSkeleton")
armature = bpy.data.objects.new("Comic30VehicleSkeleton", armature_data)
bpy.context.collection.objects.link(armature)
bpy.context.view_layer.objects.active = armature
armature.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
root = armature_data.edit_bones.new("chassis")
root.head = Vector((0, 0, 0))
root.tail = Vector((0, 0, 0.5))
for name, obj in parts.items():
    if name == "chassis":
        continue
    bone = armature_data.edit_bones.new(name)
    center = obj.matrix_world.translation
    bone.head = center
    bone.tail = center + Vector((0, 0, 0.25))
    bone.parent = root
bpy.ops.object.mode_set(mode="OBJECT")

for name, obj in parts.items():
    group = obj.vertex_groups.new(name=name)
    group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    modifier = obj.modifiers.new(name="Comic30VehicleArmature", type="ARMATURE")
    modifier.object = armature
    obj.parent = armature

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=args.output, export_format="GLB", export_skins=True, export_animations=False)
