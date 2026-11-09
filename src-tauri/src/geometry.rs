/// Map a child viewport into its iframe content quad in the parent renderer.
/// A projective transform also handles scaled, rotated and perspective frames.
pub fn project(
    points: [[f64; 2]; 4],
    q: [f64; 8],
    width: f64,
    height: f64,
) -> Result<[[f64; 2]; 4], String> {
    if width <= 0.0 || height <= 0.0 {
        return Err("iframe 可视区尺寸为零".into());
    }
    let dx1 = q[2] - q[4];
    let dx2 = q[6] - q[4];
    let dy1 = q[3] - q[5];
    let dy2 = q[7] - q[5];
    let dx3 = q[0] - q[2] + q[4] - q[6];
    let dy3 = q[1] - q[3] + q[5] - q[7];
    let (g, h) = if dx3.abs() + dy3.abs() < 1e-8 {
        (0.0, 0.0)
    } else {
        let determinant = dx1 * dy2 - dx2 * dy1;
        if determinant.abs() < 1e-10 {
            return Err("iframe 的变换无法计算".into());
        }
        (
            (dx3 * dy2 - dx2 * dy3) / determinant,
            (dx1 * dy3 - dx3 * dy1) / determinant,
        )
    };
    let a = q[2] - q[0] + g * q[2];
    let b = q[6] - q[0] + h * q[6];
    let d = q[3] - q[1] + g * q[3];
    let e = q[7] - q[1] + h * q[7];
    let mut result = [[0.0; 2]; 4];
    for (i, [x, y]) in points.into_iter().enumerate() {
        let (u, v) = (x / width, y / height);
        let divisor = g * u + h * v + 1.0;
        if divisor.abs() < 1e-10 {
            return Err("iframe 的透视变换无法计算".into());
        }
        result[i] = [
            (a * u + b * v + q[0]) / divisor,
            (d * u + e * v + q[1]) / divisor,
        ];
        if !result[i].iter().all(|n| n.is_finite()) {
            return Err("元素坐标无效".into());
        }
    }
    Ok(result)
}

pub fn bounds(points: [[f64; 2]; 4]) -> [f64; 4] {
    let left = points.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
    let top = points.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
    let right = points
        .iter()
        .map(|p| p[0])
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = points
        .iter()
        .map(|p| p[1])
        .fold(f64::NEG_INFINITY, f64::max);
    [left, top, right - left, bottom - top]
}

#[cfg(test)]
mod tests {
    use super::*;
    fn close(actual: [f64; 4], expected: [f64; 4]) {
        for (a, b) in actual.into_iter().zip(expected) {
            assert!((a - b).abs() < 1e-6, "{actual:?} != {expected:?}");
        }
    }
    #[test]
    fn frame_border_offset_and_scale() {
        let p = [[20.0, 30.0], [100.0, 30.0], [100.0, 70.0], [20.0, 70.0]];
        close(
            bounds(
                project(
                    p,
                    [105.0, 155.0, 705.0, 155.0, 705.0, 555.0, 105.0, 555.0],
                    300.0,
                    200.0,
                )
                .unwrap(),
            ),
            [145.0, 215.0, 160.0, 80.0],
        );
    }
    #[test]
    fn nested_frames_preserve_negative_and_fractional_positions() {
        let p = [[-10.5, 2.25], [9.5, 2.25], [9.5, 12.25], [-10.5, 12.25]];
        let q = [100.0, 50.0, 400.0, 50.0, 400.0, 250.0, 100.0, 250.0];
        let child = project(p, q, 300.0, 200.0).unwrap();
        close(
            bounds(project(child, q, 300.0, 200.0).unwrap()),
            [189.5, 102.25, 20.0, 10.0],
        );
    }
    #[test]
    fn rotated_frame() {
        let p = [[0.0, 0.0], [100.0, 0.0], [100.0, 50.0], [0.0, 50.0]];
        close(
            bounds(
                project(
                    p,
                    [100.0, 0.0, 100.0, 100.0, 50.0, 100.0, 50.0, 0.0],
                    100.0,
                    50.0,
                )
                .unwrap(),
            ),
            [50.0, 0.0, 50.0, 100.0],
        );
    }
    #[test]
    fn perspective_maps_all_corners() {
        let p = [[0.0, 0.0], [100.0, 0.0], [100.0, 100.0], [0.0, 100.0]];
        let q = [0.0, 0.0, 100.0, 0.0, 80.0, 80.0, 20.0, 80.0];
        let mapped = project(p, q, 100.0, 100.0).unwrap();
        for (i, point) in mapped.iter().enumerate() {
            assert!((point[0] - q[i * 2]).abs() < 1e-6);
            assert!((point[1] - q[i * 2 + 1]).abs() < 1e-6);
        }
    }
    #[test]
    fn empty_viewport_is_an_error() {
        assert!(project([[0.0; 2]; 4], [0.0; 8], 0.0, 100.0).is_err());
    }
}
