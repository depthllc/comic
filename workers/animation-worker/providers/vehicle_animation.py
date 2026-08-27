"""Generate a real articulated vehicle animation clip in Blender and export GLB."""
import argparse
import json
import math
import sys
import bpy


def parse_args():
    values = sys.argv[sys.argv.index("--") + 1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--handoff", required=True)
    parser.add_argument("--clip-id", required=True)
    parser.add_argument("--clip-name", required=True)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--duration", type=float, default=2.0)
    return parser.parse_args(values)


args = parse_args()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=args.input)
with open(args.handoff, "r", encoding="utf-8") as handle:
    handoff = json.load(handle)

armature = next((obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"), None)
if armature is None:
    raise RuntimeError("The validated vehicle GLB contains no armature.")

semantic = handoff.get("semanticBones", {})
required = ["chassis", "wheelFrontLeft", "wheelFrontRight", "wheelRearLeft", "wheelRearRight"]
missing = [name for name in required if not semantic.get(name) or semantic[name] not in armature.pose.bones]
if missing:
    raise RuntimeError("Vehicle animation requires mapped chassis and wheel bones: " + ", ".join(missing))

fps = 30
duration = max(0.5, min(30.0, args.duration))
end = max(2, round(duration * fps))
middle = max(2, end // 2)
scene = bpy.context.scene
scene.render.fps = fps
scene.frame_start = 1
scene.frame_end = end
action = bpy.data.actions.new(args.clip_name)
armature.animation_data_create()
armature.animation_data.action = action

prompt = (args.prompt + " " + args.clip_name).lower()
for semantic_name in required:
    bone = armature.pose.bones[semantic[semantic_name]]
    bone.rotation_mode = "XYZ"
    if semantic_name.startswith("wheel"):
        for frame, turn in ((1, 0.0), (middle, math.tau * 2.0), (end, math.tau * 4.0)):
            bone.rotation_euler[0] = turn
            bone.location.z = (0.04 if frame == middle and ("impact" in prompt or "suspension" in prompt) else 0.0)
            bone.keyframe_insert(data_path="rotation_euler", frame=frame)
            bone.keyframe_insert(data_path="location", frame=frame)
    else:
        for frame, roll, lift in ((1, 0.0, 0.0), (middle, 0.04 if "turn" in prompt else 0.018, 0.025 if "jump" in prompt else 0.0), (end, 0.0, 0.0)):
            bone.rotation_euler[1] = roll
            bone.location.z = lift
            bone.keyframe_insert(data_path="rotation_euler", frame=frame)
            bone.keyframe_insert(data_path="location", frame=frame)

for fcurve in action.fcurves:
    for point in fcurve.keyframe_points:
        point.interpolation = "LINEAR"

bpy.ops.object.select_all(action="SELECT")
kwargs = dict(filepath=args.output, export_format="GLB", export_skins=True, export_animations=True)
try:
    bpy.ops.export_scene.gltf(**kwargs, export_animation_mode="ACTIVE_ACTIONS", export_force_sampling=True)
except TypeError:
    bpy.ops.export_scene.gltf(**kwargs)
