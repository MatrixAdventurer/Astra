mod common;

use astra_core::JwtSettings;
use astra_services::{
    AuthLoginRequestData, AuthRefreshRequestData, AuthRegisterRequestData, AuthService,
    DatabaseAuthService,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};

fn headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    headers
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires live MatrixOne: ASTRA_TEST_DB_IT=1"]
async fn logout_revokes_the_session_across_refresh_rotation_without_revoking_other_sessions() {
    let (pool, settings) = common::setup_pool_and_settings().await;
    let service = DatabaseAuthService::new(
        settings,
        JwtSettings {
            secret_key: "isolated-logout-rotation-test-key".into(),
            algorithm: "HS256".into(),
            access_token_expire_minutes: 5,
            refresh_token_expire_days: 1,
        },
    )
    .with_pool(pool.clone());
    let username = format!("logout_{}", uuid::Uuid::new_v4().simple());
    let password = "correct-horse-battery-staple";
    let user = service
        .register(AuthRegisterRequestData {
            username: username.clone(),
            email: format!("{username}@example.test"),
            password: password.into(),
            display_name: None,
        })
        .await
        .unwrap();
    let login = || AuthLoginRequestData {
        username: username.clone(),
        password: password.into(),
    };
    let original = service.login(login()).await.unwrap();
    let other = service.login(login()).await.unwrap();
    for invalid in [original.access_token.clone(), "invalid.token".to_string()] {
        assert_eq!(
            service
                .logout(AuthRefreshRequestData {
                    refresh_token: invalid,
                })
                .await
                .unwrap_err()
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    let rotated = service
        .refresh(AuthRefreshRequestData {
            refresh_token: original.refresh_token.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        service
            .refresh(AuthRefreshRequestData {
                refresh_token: original.refresh_token.clone()
            })
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    service
        .logout(AuthRefreshRequestData {
            refresh_token: original.refresh_token.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        service
            .refresh(AuthRefreshRequestData {
                refresh_token: rotated.refresh_token
            })
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        service
            .current_principal(&headers(&rotated.access_token))
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    service
        .current_principal(&headers(&other.access_token))
        .await
        .expect("another session remains active");

    // Exercise simultaneous refresh and logout with three independently issued sessions.
    // Whichever transaction wins, no successor from that session may stay usable.
    for _ in 0..3 {
        let token = service.login(login()).await.unwrap();
        let (refreshed, logged_out) = tokio::join!(
            service.refresh(AuthRefreshRequestData {
                refresh_token: token.refresh_token.clone()
            }),
            service.logout(AuthRefreshRequestData {
                refresh_token: token.refresh_token.clone()
            }),
        );
        logged_out.unwrap();
        match refreshed {
            Ok(next) => {
                assert_eq!(
                    service
                        .refresh(AuthRefreshRequestData {
                            refresh_token: next.refresh_token
                        })
                        .await
                        .unwrap_err()
                        .0,
                    StatusCode::UNAUTHORIZED
                );
                assert_eq!(
                    service
                        .current_principal(&headers(&next.access_token))
                        .await
                        .unwrap_err()
                        .0,
                    StatusCode::UNAUTHORIZED
                );
            }
            Err(error) => assert_eq!(error.0, StatusCode::UNAUTHORIZED),
        }
        service
            .current_principal(&headers(&other.access_token))
            .await
            .expect("another session remains active");
    }
    for table in ["auth_refresh_tokens", "auth_user_roles", "auth_users"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE user_id = ?"
        )))
        .bind(&user.user_id)
        .execute(pool.get())
        .await
        .unwrap();
    }
    pool.get().close().await;
}
