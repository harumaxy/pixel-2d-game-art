"""
Render openpose joints + depth maps for every motion / direction / frame from
Mixamo FBX clips. Runs inside Blender:

  blender --background --python scripts/mixamo_poses.py -- \
      --out out/poses --motions out/poses/motions.json --fbx-dir motions/mixamo \
      [--rig mixamo|quaternius] --size 512 --elev 25

A motion entry names either a per-clip FBX (Mixamo) or an "action" inside the
rig's base FBX (Quaternius: one file holds mesh + every clip).
Writes <out>/<id>/<dir>/<k>.json and <k>.depth.png. Progress goes to stdout.
Blender exits 0 even on an uncaught exception, so main() is wrapped and exits
1 on failure.
"""

import json
import math
import os
import sys
import traceback

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

DIRS8 = ["down", "downright", "right", "upright", "up", "upleft", "left", "downleft"]
# Camera azimuth per direction. The character faces -Y after FBX import; a
# camera at -Y (az 0) sees the front, az 270 (-X) sees the character walking
# to the viewer's right.
AZIMUTH = {"down": 0, "downright": 315, "right": 270, "upright": 225,
           "up": 180, "upleft": 135, "left": 90, "downleft": 45}
CAM_DIST = 10.0
DEPTH_RANGE = 0.8  # metres either side of the hips that map to white..black

# Per rig: the base FBX (mesh + skeleton), bone-name prefix, and the bone whose
# head is each openpose joint. Both rigs' Head bones share the same axes
# (x = character's left, y = up, z = forward), checked in Blender.
RIGS = {
    "mixamo": {
        "base": "Y Bot.fbx",
        "prefix": "mixamorig:",
        "hips": "Hips", "lhip": "LeftUpLeg", "rhip": "RightUpLeg", "head": "Head",
        "bones": {
            "neck": "Neck",
            "rsho": "RightArm", "relb": "RightForeArm", "rwri": "RightHand",
            "lsho": "LeftArm", "lelb": "LeftForeArm", "lwri": "LeftHand",
            "rhip": "RightUpLeg", "rkne": "RightLeg", "rank": "RightFoot",
            "lhip": "LeftUpLeg", "lkne": "LeftLeg", "lank": "LeftFoot",
        },
    },
    "quaternius": {
        "base": "UAL1_Standard.fbx",
        "prefix": "",
        "hips": "pelvis", "lhip": "thigh_l", "rhip": "thigh_r", "head": "Head",
        "bones": {
            "neck": "neck_01",
            "rsho": "upperarm_r", "relb": "lowerarm_r", "rwri": "hand_r",
            "lsho": "upperarm_l", "lelb": "lowerarm_l", "lwri": "hand_l",
            "rhip": "thigh_r", "rkne": "calf_r", "rank": "foot_r",
            "lhip": "thigh_l", "lkne": "calf_l", "lank": "foot_l",
        },
    },
}
RIG = RIGS["mixamo"]  # set from --rig in main()
# Face points as offsets in the Head bone's frame (x = character's left, y = up, z = forward), metres.
HEAD_OFFSETS = {
    "nose": (0.0, 0.05, 0.10),
    "reye": (-0.03, 0.08, 0.09), "leye": (0.03, 0.08, 0.09),
    "rear": (-0.07, 0.07, 0.0), "lear": (0.07, 0.07, 0.0),
}
EAR_HIDE_DOT = 0.8  # |head.x · camera| above this = profile view, far ear hidden
FACE_HIDE_DOT = -0.3  # head.forward · camera below this = seen from behind, face hidden


def log(msg):
    print("[mixamo_poses] " + msg, flush=True)


def frame_times(start, end, n, loop):
    """Clip frame numbers for n samples. loop: stop before the wrap; else include the end."""
    if n == 1:
        return [start]
    span = end - start
    step = span / n if loop else span / (n - 1)
    return [start + k * step for k in range(n)]


def self_check():
    assert frame_times(1, 33, 4, True) == [1, 9, 17, 25]
    assert frame_times(1, 31, 4, False) == [1, 11, 21, 31]
    assert frame_times(5, 9, 1, True) == [5]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"size": "512", "elev": "25", "rig": "mixamo"}
    key = None
    for a in argv:
        if a.startswith("--"):
            key = a[2:]
            opts[key] = True
        elif key:
            opts[key] = a
            key = None
    for k in ("out", "motions", "fbx-dir"):
        if k not in opts or opts[k] is True:
            raise SystemExit(f"missing --{k}")
    if opts["rig"] not in RIGS:
        raise SystemExit(f"--rig must be one of {', '.join(RIGS)}")
    return opts


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)


def import_armature(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    return next(o for o in new if o.type == "ARMATURE"), new


def setup_camera(scene, size):
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.clip_start = 0.1
    cam_data.clip_end = 100
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "BW"
    scene.render.image_settings.color_depth = "8"
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.view_settings.view_transform = "Standard"
    return cam


def setup_depth_compositor(scene):
    """Depth pass -> map [CAM_DIST-R, CAM_DIST+R] to [1, 0], clamped. Background is 0."""
    bpy.context.view_layer.use_pass_z = True
    scene.render.use_compositing = True
    ng = bpy.data.node_groups.new("px_depth", "CompositorNodeTree")
    scene.compositing_node_group = ng
    rl = ng.nodes.new("CompositorNodeRLayers")
    mr = ng.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = CAM_DIST - DEPTH_RANGE
    mr.inputs["From Max"].default_value = CAM_DIST + DEPTH_RANGE
    mr.inputs["To Min"].default_value = 1.0
    mr.inputs["To Max"].default_value = 0.0
    mr.clamp = True
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    out = ng.nodes.new("NodeGroupOutput")
    ng.links.new(rl.outputs["Depth"], mr.inputs["Value"])
    ng.links.new(mr.outputs[0], out.inputs[0])


def place_camera(cam, target, az_deg, el_deg):
    az, el = math.radians(az_deg), math.radians(el_deg)
    d = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    cam.location = target + d * CAM_DIST
    cam.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return d


def rest_height(rig, objects):
    """Standing height: bones plus any mesh (the Quaternius skeleton stops below the scalp)."""
    zs = []
    for b in rig.data.bones:
        zs.append((rig.matrix_world @ b.head_local).z)
        zs.append((rig.matrix_world @ b.tail_local).z)
    for o in objects:
        if o.type == "MESH":
            zs.extend((o.matrix_world @ Vector(c)).z for c in o.bound_box)
    return max(zs) - min(zs)


def joint_world(rig, name):
    return rig.matrix_world @ rig.pose.bones[RIG["prefix"] + name].head


def base_yaw(rig):
    """Degrees the character's facing deviates from world -Y, from the pelvis (left hip minus right hip)."""
    left = joint_world(rig, RIG["lhip"]) - joint_world(rig, RIG["rhip"])
    left.z = 0
    left.normalize()
    forward = left.cross(Vector((0, 0, 1)))  # left x up = forward (faces -Y for an unrotated Mixamo rig)
    return math.degrees(math.atan2(forward.x, -forward.y))


def head_frame(rig):
    """(origin, x, y, z) of the Head bone in world space, axes normalised (the rig is scaled 0.01)."""
    m = rig.matrix_world @ rig.pose.bones[RIG["prefix"] + RIG["head"]].matrix
    return (m.translation.copy(), m.col[0].xyz.normalized(), m.col[1].xyz.normalized(), m.col[2].xyz.normalized())


def pose_json(scene, cam, rig, cam_dir):
    def project(p):
        v = world_to_camera_view(scene, cam, p)
        return round(v.x, 4), round(1 - v.y, 4)

    pose = {}
    for joint, bone in RIG["bones"].items():
        x, y = project(joint_world(rig, bone))
        pose[joint] = {"x": x, "y": y, "visible": True}
    origin, ax, ay, az = head_frame(rig)
    facing = az.dot(cam_dir)      # >0 face toward camera
    side = ax.dot(cam_dir)        # >0 character's left side toward camera
    for joint, (ox, oy, oz) in HEAD_OFFSETS.items():
        x, y = project(origin + ax * ox + ay * oy + az * oz)
        visible = True
        if joint == "nose" and facing < FACE_HIDE_DOT:
            visible = False
        if joint == "reye" and (facing < FACE_HIDE_DOT or side > EAR_HIDE_DOT):
            visible = False
        if joint == "leye" and (facing < FACE_HIDE_DOT or side < -EAR_HIDE_DOT):
            visible = False
        if joint == "rear" and side > EAR_HIDE_DOT:
            visible = False
        if joint == "lear" and side < -EAR_HIDE_DOT:
            visible = False
        pose[joint] = {"x": x, "y": y, "visible": visible}
    return pose


def main():
    self_check()
    if bpy.app.version < (5, 0):
        sys.exit(f"mixamo_poses.py needs Blender 5.0+ (found {bpy.app.version_string})")
    global RIG
    opts = parse_args()
    RIG = RIGS[opts["rig"]]
    out_dir, fbx_dir = os.path.abspath(opts["out"]), os.path.abspath(opts["fbx-dir"])
    size, elev = int(opts["size"]), float(opts["elev"])
    os.makedirs(out_dir, exist_ok=True)
    with open(opts["motions"], encoding="utf-8") as f:
        motions = json.load(f)

    needed = {m["fbx"] for m in motions} | {RIG["base"]}
    missing = sorted(f for f in needed if not os.path.exists(os.path.join(fbx_dir, f)))
    if missing:
        sys.stderr.write("missing in " + fbx_dir + ": " + ", ".join(missing) + "\n")
        sys.exit(1)

    scene = bpy.context.scene
    clear_scene()
    rig, base_objects = import_armature(os.path.join(fbx_dir, RIG["base"]))
    rig.animation_data_create()
    base_actions = list(bpy.data.actions)
    cam = setup_camera(scene, size)
    setup_depth_compositor(scene)
    height = rest_height(rig, base_objects)
    cam.data.ortho_scale = height * 1.15
    # The camera follows the hips across the ground but not up and down: a
    # crouch then sinks and a jump rises inside the frame, and the feet of a
    # walk stay on one line instead of the hips. Rest height = standing height.
    ground_hips_z = (rig.matrix_world @ rig.data.bones[RIG["prefix"] + RIG["hips"]].head_local).z
    log(f"blender {bpy.app.version_string}, rig {opts['rig']} height {height:.2f} m, {len(motions)} motions, elev {elev}")

    written = 0
    for m in motions:
        if "action" in m and m["fbx"] == RIG["base"]:
            # Clip lives in the base file, e.g. "Armature|Armature|Walk_Loop".
            action = next(a for a in base_actions if a.name.split("|")[-1] == m["action"])
        else:
            # Own file: one Mixamo clip, or another same-rig library (UAL2) picked by action name.
            before = set(bpy.data.actions)
            anim, new = import_armature(os.path.join(fbx_dir, m["fbx"]))
            if "action" in m:
                action = next(a for a in bpy.data.actions if a not in before and a.name.split("|")[-1] == m["action"])
            else:
                action = anim.animation_data.action
            for o in new:
                bpy.data.objects.remove(o, do_unlink=True)
        rig.animation_data.action = action
        start, end = action.frame_range
        times = frame_times(start, end, int(m["frames"]), bool(m["loop"]))
        log(f"{m['id']}: {m.get('action', m['fbx'])} frames {start:.0f}..{end:.0f} -> {[round(t, 1) for t in times]}")
        t0 = times[0]
        scene.frame_set(int(t0), subframe=t0 - int(t0))
        bpy.context.view_layer.update()
        yaw = base_yaw(rig)
        log(f"{m['id']}: base yaw {yaw:.0f} deg")
        for d in DIRS8:
            dest = os.path.join(out_dir, m["id"], d)
            os.makedirs(dest, exist_ok=True)
            for k, t in enumerate(times):
                scene.frame_set(int(t), subframe=t - int(t))
                bpy.context.view_layer.update()
                hips = joint_world(rig, RIG["hips"])
                target = Vector((hips.x, hips.y, ground_hips_z))
                cam_dir = place_camera(cam, target, AZIMUTH[d] + yaw, elev)
                bpy.context.view_layer.update()
                with open(os.path.join(dest, f"{k}.json"), "w", encoding="utf-8") as f:
                    json.dump(pose_json(scene, cam, rig, cam_dir), f)
                scene.render.filepath = os.path.join(dest, f"{k}.depth.png")
                bpy.ops.render.render(write_still=True)
                written += 1
    log(f"done: {written} frames -> {out_dir}")


try:
    main()
except SystemExit:
    raise
except Exception:
    sys.stderr.write(traceback.format_exc())
    sys.exit(1)
