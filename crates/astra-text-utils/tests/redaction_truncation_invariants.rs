//! Budget-sweep invariants for the redaction-aware truncation and paging
//! helpers: no budget may emit a partial redaction marker or re-expose a
//! redacted value, and redaction itself must be idempotent.

use astra_text_utils::credential_redaction::{
    SafeOutputProjection, redact_credentials_for_display, redact_credentials_in_text,
    redact_line_window, redaction_marker_status, truncate_redacted_head_tail,
    truncate_redacted_head_tail_chars, truncate_redacted_output,
};
use astra_text_utils::str_preview::{shorten_path, truncate_line};

const SECRET: &str = "abcdefghijklmnop";

fn every_marker_is_complete(text: &str) -> bool {
    text.split("[REDACTED:")
        .skip(1)
        .all(|rest| rest.contains(']'))
}

fn redacted_fixture() -> String {
    let raw = format!("数据 password={SECRET} 行\n").repeat(40);
    let (redacted, count) = redact_credentials_in_text(&raw);
    assert_eq!(count, 40);
    redacted
}

#[test]
fn truncation_helpers_never_split_a_marker_for_any_budget() {
    let redacted = redacted_fixture();
    for budget in (0..=redacted.len() + 1).step_by(7) {
        for output in [
            truncate_redacted_head_tail(&redacted, budget),
            truncate_redacted_head_tail_chars(&redacted, budget),
            truncate_redacted_output(redacted.clone(), budget),
        ] {
            assert!(every_marker_is_complete(&output), "budget={budget}");
            assert!(!output.contains(SECRET), "budget={budget}");
        }
    }
}

#[test]
fn truncation_helpers_are_identity_within_budget() {
    let redacted = redacted_fixture();
    let chars = redacted.chars().count();
    assert_eq!(
        truncate_redacted_head_tail(&redacted, redacted.len()),
        redacted
    );
    assert_eq!(
        truncate_redacted_head_tail_chars(&redacted, chars),
        redacted
    );
    assert_eq!(
        truncate_redacted_output(redacted.clone(), redacted.len()),
        redacted
    );
}

#[test]
fn display_and_edit_redaction_are_idempotent() {
    let raw = format!(
        "token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\npassword={SECRET}\n\
         -----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n"
    );
    let (display, display_count) = redact_credentials_for_display(&raw);
    assert_eq!(display_count, 3);
    assert_eq!(
        redact_credentials_for_display(&display),
        (display.clone(), 0)
    );

    let (edit, edit_count) = redact_credentials_in_text(&raw);
    assert_eq!(edit_count, 3);
    assert_eq!(redact_credentials_in_text(&edit), (edit.clone(), 0));
    assert_eq!(redaction_marker_status(&edit), (true, true));
    assert_eq!(redaction_marker_status(&display), (false, true));
    assert_eq!(redaction_marker_status("plain"), (false, false));
}

#[test]
fn paging_a_projection_reaches_the_end_without_partial_markers() {
    let (safe, _) = redact_credentials_for_display(&format!("x password={SECRET} y\n").repeat(20));
    for page in [1usize, 5, 17, 23, 64, 4096] {
        let projection = SafeOutputProjection::new(safe.clone());
        let mut offset = 0;
        let mut pages = 0;
        loop {
            let (window, next, total, _) = projection.window(offset, page);
            assert!(
                every_marker_is_complete(&window),
                "page={page} offset={offset}"
            );
            if next >= total {
                break;
            }
            assert!(next > offset, "paging stalled: page={page} offset={offset}");
            offset = next;
            pages += 1;
            assert!(pages <= safe.len(), "paging did not terminate: page={page}");
        }
    }
}

#[test]
fn line_window_clamps_out_of_range_requests() {
    let raw = format!("a\npassword={SECRET}\nb");
    assert!(!redact_line_window(&raw, 2, 2).contains(SECRET));
    assert_eq!(redact_line_window(&raw, 1, 1), "a");
    assert_eq!(redact_line_window(&raw, 0, 0), "");
    assert_eq!(redact_line_window(&raw, 5, 9), "");
    assert_eq!(redact_line_window(&raw, 3, 1), "");
    assert_eq!(redact_line_window(&raw, 3, 99), "b");
}

#[test]
fn truncate_line_uses_first_line_and_counts_scalars() {
    assert_eq!(truncate_line("first\nsecond", 20), "first");
    assert_eq!(truncate_line("hello world", 5), "hell…");
    assert_eq!(truncate_line("数据数据数据", 4), "数据数…");
    assert_eq!(truncate_line("", 3), "");
}

#[test]
fn shorten_path_output_respects_budget() {
    for (path, budget) in [
        ("/a/b/c/d/e/file.txt", 15),
        ("/very/long/directory/name/file.rs", 12),
        ("/x/数据目录/文件名.rs", 9),
        ("/a/b/c.txt", 3),
    ] {
        let short = shorten_path(path, budget);
        assert!(
            short.chars().count() <= budget,
            "{path} -> {short} > {budget}"
        );
    }
}
